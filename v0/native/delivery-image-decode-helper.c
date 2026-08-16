#define _DARWIN_C_SOURCE

// Read-only ImageIO decode worker for Stage B delivery preflight. The caller
// supplies one exact snapshot entry's bytes over stdin; this helper never
// receives a project root, pathname, URL, or output destination.
#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <stdint.h>
#include <unistd.h>
#include <zlib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_BYTES (25U * 1024U * 1024U)
#define MAX_DIMENSION 16384U
#define MAX_PIXELS 40000000ULL

static void error_line(const char *code) {
  (void)fprintf(stdout, "ERR\t%s\n", code);
}

static int read_all(unsigned char **out, size_t *length) {
  unsigned char *buffer = malloc(MAX_BYTES);
  if (buffer == NULL) return 0;
  size_t used = 0U;
  while (used < MAX_BYTES) {
    ssize_t count = read(STDIN_FILENO, buffer + used, MAX_BYTES - used);
    if (count < 0) { free(buffer); return 0; }
    if (count == 0) break;
    used += (size_t)count;
  }
  unsigned char extra;
  if (used == MAX_BYTES && read(STDIN_FILENO, &extra, 1U) > 0) { free(buffer); return 0; }
  *out = buffer;
  *length = used;
  return used > 0U;
}

static int expected_type(CGImageSourceRef source, const char *kind) {
  CFStringRef type = CGImageSourceGetType(source);
  if (type == NULL) return 0;
  if (strcmp(kind, "png") == 0) return CFStringCompare(type, CFSTR("public.png"), 0) == kCFCompareEqualTo;
  return CFStringCompare(type, CFSTR("public.jpeg"), 0) == kCFCompareEqualTo;
}

static void print_digest(const unsigned char *bytes, size_t length, size_t width, size_t height) {
  CC_SHA256_CTX context;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Init(&context);
  CC_SHA256_Update(&context, bytes, (CC_LONG)length);
  CC_SHA256_Update(&context, &width, (CC_LONG)sizeof(width));
  CC_SHA256_Update(&context, &height, (CC_LONG)sizeof(height));
  CC_SHA256_Final(digest, &context);
  (void)fprintf(stdout, "OK\t%zu\t%zu\tsha256:", width, height);
  for (size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1U) (void)fprintf(stdout, "%02x", digest[index]);
  (void)fprintf(stdout, "\n");
}

static bool valid_hex_digest(const char *value) {
  if (value == NULL || strncmp(value, "sha256:", 7U) != 0 || strlen(value) != 71U) return false;
  for (size_t index = 7U; index < 71U; index += 1U) {
    const char character = value[index];
    if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
  }
  return true;
}

static bool parse_u64_text(const char *value, uint64_t *out) {
  if (value == NULL || *value == '\0') return false;
  for (const char *cursor = value; *cursor != '\0'; cursor += 1) {
    if (*cursor < '0' || *cursor > '9') return false;
  }
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == NULL || *end != '\0') return false;
  *out = (uint64_t)parsed;
  return true;
}

static bool read_exact_fd(int fd, unsigned char *buffer, size_t length, uint64_t offset) {
  size_t received = 0U;
  while (received < length) {
    ssize_t count = pread(fd, buffer + received, length - received, (off_t)(offset + received));
    if (count <= 0) return false;
    received += (size_t)count;
  }
  return true;
}

static uint32_t crc32_bytes(const unsigned char *bytes, size_t length) {
  uint32_t crc = 0xffffffffU;
  for (size_t index = 0U; index < length; index += 1U) {
    crc ^= bytes[index];
    for (unsigned bit = 0U; bit < 8U; bit += 1U) {
      crc = (crc >> 1U) ^ (0xedb88320U & (uint32_t)-(int)(crc & 1U));
    }
  }
  return crc ^ 0xffffffffU;
}

static uint32_t read_u32_be(const unsigned char *bytes) {
  return ((uint32_t)bytes[0] << 24U) | ((uint32_t)bytes[1] << 16U) |
    ((uint32_t)bytes[2] << 8U) | (uint32_t)bytes[3];
}

static uint64_t read_u64_be(const unsigned char *bytes) {
  uint64_t value = 0U;
  for (size_t index = 0U; index < 8U; index += 1U) value = (value << 8U) | bytes[index];
  return value;
}

static void sha256_text(const unsigned char *bytes, size_t length, char out[72]) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes, (CC_LONG)length, digest);
  memcpy(out, "sha256:", 7U);
  for (size_t index = 0U; index < sizeof(digest); index += 1U) (void)snprintf(out + 7U + index * 2U, 3U, "%02x", digest[index]);
  out[71] = '\0';
}

static bool validate_png_stream(const unsigned char *bytes, size_t length) {
  static const unsigned char signature[] = {0x89U, 0x50U, 0x4eU, 0x47U, 0x0dU, 0x0aU, 0x1aU, 0x0aU};
  if (length < sizeof(signature) || memcmp(bytes, signature, sizeof(signature)) != 0) return false;
  size_t offset = sizeof(signature);
  unsigned char *idat = malloc(length);
  if (idat == NULL) return false;
  size_t idat_length = 0U;
  bool has_ihdr = false;
  bool has_idat = false;
  bool has_iend = false;
  uint32_t width = 0U;
  uint32_t height = 0U;
  unsigned bit_depth = 0U;
  unsigned color_type = 0U;
  unsigned interlace = 0U;
  bool valid = true;
  while (valid && offset + 12U <= length) {
    const uint32_t chunk_length = read_u32_be(bytes + offset);
    const size_t end = offset + 12U + (size_t)chunk_length;
    if (end < offset || end > length) { valid = false; break; }
    const unsigned char *type = bytes + offset + 4U;
    const unsigned char *data = bytes + offset + 8U;
    const uint32_t stored_crc = read_u32_be(bytes + offset + 8U + chunk_length);
    unsigned char *crc_input = malloc((size_t)chunk_length + 4U);
    if (crc_input == NULL) { valid = false; break; }
    memcpy(crc_input, type, 4U);
    memcpy(crc_input + 4U, data, chunk_length);
    const uint32_t actual_crc = crc32_bytes(crc_input, (size_t)chunk_length + 4U);
    free(crc_input);
    if (actual_crc != stored_crc) { valid = false; break; }
    if (!has_ihdr) {
      if (memcmp(type, "IHDR", 4U) != 0 || chunk_length != 13U) { valid = false; break; }
      has_ihdr = true;
      width = read_u32_be(data);
      height = read_u32_be(data + 4U);
      bit_depth = data[8]; color_type = data[9]; interlace = data[12];
      if (width < 1U || height < 1U || width > MAX_DIMENSION || height > MAX_DIMENSION ||
          (uint64_t)width * (uint64_t)height > MAX_PIXELS || interlace != 0U) { valid = false; break; }
      if (!((color_type == 0U && (bit_depth == 1U || bit_depth == 2U || bit_depth == 4U || bit_depth == 8U || bit_depth == 16U)) ||
            (color_type == 2U && (bit_depth == 8U || bit_depth == 16U)) ||
            (color_type == 3U && (bit_depth == 1U || bit_depth == 2U || bit_depth == 4U || bit_depth == 8U)) ||
            (color_type == 4U && (bit_depth == 8U || bit_depth == 16U)) ||
            (color_type == 6U && (bit_depth == 8U || bit_depth == 16U)))) { valid = false; break; }
    } else if (memcmp(type, "IHDR", 4U) == 0) {
      valid = false;
    }
    if (memcmp(type, "IDAT", 4U) == 0) {
      if (idat_length > length - (size_t)chunk_length) { valid = false; break; }
      memcpy(idat + idat_length, data, chunk_length);
      idat_length += chunk_length;
      has_idat = true;
    } else if (memcmp(type, "IEND", 4U) == 0) {
      if (chunk_length != 0U || has_iend || end != length) { valid = false; break; }
      has_iend = true;
      offset = end;
      break;
    }
    offset = end;
  }
  if (!valid || !has_ihdr || !has_idat || !has_iend) { free(idat); return false; }
  const unsigned channels = color_type == 0U ? 1U : color_type == 2U ? 3U : color_type == 3U ? 1U : color_type == 4U ? 2U : 4U;
  const uint64_t row_bytes = ((uint64_t)width * channels * bit_depth + 7U) / 8U;
  const uint64_t expected = (row_bytes + 1U) * height;
  if (row_bytes == 0U || expected > (uint64_t)160U * 1024U * 1024U) { free(idat); return false; }
  z_stream stream;
  memset(&stream, 0, sizeof(stream));
  stream.next_in = idat;
  stream.avail_in = (uInt)idat_length;
  if (inflateInit(&stream) != Z_OK) { free(idat); return false; }
  unsigned char output[65536];
  uint64_t produced = 0U;
  int result = Z_OK;
  while (result == Z_OK && produced <= expected) {
    stream.next_out = output;
    stream.avail_out = (uInt)sizeof(output);
    result = inflate(&stream, Z_NO_FLUSH);
    const size_t count = sizeof(output) - stream.avail_out;
    for (size_t index = 0U; index < count; index += 1U) {
      const uint64_t position = produced + index;
      if (position % (row_bytes + 1U) == 0U && output[index] > 4U) result = Z_DATA_ERROR;
    }
    produced += count;
    if (produced > expected) result = Z_DATA_ERROR;
  }
  const bool inflated = result == Z_STREAM_END && produced == expected && stream.avail_in == 0U;
  (void)inflateEnd(&stream);
  free(idat);
  return inflated;
}

typedef struct {
  uint16_t code[256];
  unsigned char size[256];
  unsigned char value[256];
  size_t count;
} JpegHuffmanTable;

typedef struct {
  unsigned char id;
  unsigned char h;
  unsigned char v;
  unsigned char dc_table;
  unsigned char ac_table;
  int dc_prediction;
} JpegComponent;

typedef struct {
  const unsigned char *bytes;
  size_t length;
  size_t offset;
  unsigned current;
  unsigned bits_left;
} JpegBitReader;

static bool jpeg_huffman_build(JpegHuffmanTable *table, const unsigned char *bits, const unsigned char *values, size_t value_count) {
  if (table == NULL || bits == NULL || values == NULL || value_count == 0U || value_count > 256U) return false;
  memset(table, 0, sizeof(*table));
  unsigned code = 0U;
  size_t value_offset = 0U;
  for (unsigned length = 1U; length <= 16U; length += 1U) {
    const unsigned count = bits[length - 1U];
    if (count > 255U - table->count || value_offset + count > value_count) return false;
    if (code + count > (1U << length)) return false;
    for (unsigned index = 0U; index < count; index += 1U) {
      table->code[table->count] = (uint16_t)code;
      table->size[table->count] = (unsigned char)length;
      table->value[table->count] = values[value_offset + index];
      table->count += 1U;
      code += 1U;
    }
    code <<= 1U;
    value_offset += count;
  }
  return value_offset == value_count;
}

static bool jpeg_reader_fill(JpegBitReader *reader) {
  if (reader == NULL || reader->offset >= reader->length) return false;
  unsigned value = reader->bytes[reader->offset++];
  if (value == 0xffU) {
    while (reader->offset < reader->length && reader->bytes[reader->offset] == 0xffU) reader->offset += 1U;
    if (reader->offset >= reader->length || reader->bytes[reader->offset] != 0x00U) return false;
    reader->offset += 1U;
  }
  reader->current = value;
  reader->bits_left = 8U;
  return true;
}

static bool jpeg_reader_bit(JpegBitReader *reader, unsigned *out) {
  if (reader == NULL || out == NULL) return false;
  if (reader->bits_left == 0U && !jpeg_reader_fill(reader)) return false;
  reader->bits_left -= 1U;
  *out = (reader->current >> reader->bits_left) & 1U;
  return true;
}

static bool jpeg_reader_bits(JpegBitReader *reader, unsigned count, unsigned *out) {
  if (count > 16U || out == NULL) return false;
  unsigned value = 0U;
  for (unsigned index = 0U; index < count; index += 1U) {
    unsigned bit = 0U;
    if (!jpeg_reader_bit(reader, &bit)) return false;
    value = (value << 1U) | bit;
  }
  *out = value;
  return true;
}

static bool jpeg_reader_align(JpegBitReader *reader) {
  if (reader == NULL) return false;
  if (reader->bits_left > 0U) {
    const unsigned mask = (1U << reader->bits_left) - 1U;
    if ((reader->current & mask) != mask) return false;
    reader->bits_left = 0U;
  }
  return true;
}

static bool jpeg_reader_marker(JpegBitReader *reader, unsigned *marker) {
  if (reader == NULL || marker == NULL || !jpeg_reader_align(reader) || reader->offset >= reader->length || reader->bytes[reader->offset++] != 0xffU) return false;
  while (reader->offset < reader->length && reader->bytes[reader->offset] == 0xffU) reader->offset += 1U;
  if (reader->offset >= reader->length) return false;
  *marker = reader->bytes[reader->offset++];
  return *marker != 0x00U;
}

static bool jpeg_huffman_value(JpegBitReader *reader, const JpegHuffmanTable *table, unsigned *out) {
  if (reader == NULL || table == NULL || out == NULL || table->count == 0U) return false;
  unsigned code = 0U;
  for (unsigned length = 1U; length <= 16U; length += 1U) {
    unsigned bit = 0U;
    if (!jpeg_reader_bit(reader, &bit)) return false;
    code = (code << 1U) | bit;
    for (size_t index = 0U; index < table->count; index += 1U) {
      if (table->size[index] == length && table->code[index] == code) {
        *out = table->value[index];
        return true;
      }
    }
  }
  return false;
}

static int jpeg_extend(unsigned value, unsigned bits) {
  if (bits == 0U) return 0;
  const unsigned threshold = 1U << (bits - 1U);
  if (value < threshold) return (int)value - (int)((1U << bits) - 1U);
  return (int)value;
}

static bool jpeg_decode_block(JpegBitReader *reader, const JpegHuffmanTable *dc, const JpegHuffmanTable *ac, int *prediction) {
  unsigned symbol = 0U;
  if (!jpeg_huffman_value(reader, dc, &symbol) || symbol > 11U) return false;
  unsigned bits = 0U;
  if (!jpeg_reader_bits(reader, symbol, &bits)) return false;
  if (prediction != NULL) *prediction += jpeg_extend(bits, symbol);
  unsigned coefficient = 0U;
  while (coefficient < 63U) {
    if (!jpeg_huffman_value(reader, ac, &symbol)) return false;
    if (symbol == 0U) return true;
    if (symbol == 0xf0U) {
      if (coefficient > 47U) return false;
      coefficient += 16U;
      continue;
    }
    const unsigned run = symbol >> 4U;
    const unsigned size = symbol & 0x0fU;
    if (size == 0U || size > 10U || run > 15U || coefficient + run >= 63U) return false;
    coefficient += run + 1U;
    if (!jpeg_reader_bits(reader, size, &bits)) return false;
  }
  return true;
}

static bool validate_jpeg_entropy(const unsigned char *bytes, size_t length) {
  if (bytes == NULL || length < 4U || bytes[0] != 0xffU || bytes[1] != 0xd8U) return false;
  JpegHuffmanTable dc_tables[4]; JpegHuffmanTable ac_tables[4];
  memset(dc_tables, 0, sizeof(dc_tables)); memset(ac_tables, 0, sizeof(ac_tables));
  JpegComponent components[4]; memset(components, 0, sizeof(components));
  unsigned component_count = 0U; unsigned width = 0U; unsigned height = 0U; unsigned max_h = 0U; unsigned max_v = 0U;
  unsigned restart_interval = 0U; bool saw_frame = false; size_t offset = 2U;
  while (offset + 1U < length) {
    if (bytes[offset++] != 0xffU) return false;
    while (offset < length && bytes[offset] == 0xffU) offset += 1U;
    if (offset >= length) return false;
    const unsigned marker = bytes[offset++];
    if (marker == 0xdaU) {
      if (!saw_frame || offset + 2U > length) return false;
      const uint16_t segment = (uint16_t)(((uint16_t)bytes[offset] << 8U) | bytes[offset + 1U]);
      if (segment < 8U || offset + segment > length) return false;
      const unsigned scan_components = bytes[offset + 2U];
      if (scan_components != component_count || segment != (size_t)(6U + 2U * scan_components) || bytes[offset + segment - 3U] != 0U || bytes[offset + segment - 2U] != 63U || bytes[offset + segment - 1U] != 0U) return false;
      for (unsigned index = 0U; index < scan_components; index += 1U) {
        const unsigned id = bytes[offset + 3U + index * 2U]; const unsigned tables = bytes[offset + 4U + index * 2U];
        bool found = false;
        for (unsigned component = 0U; component < component_count; component += 1U) if (components[component].id == id) {
          if (tables >> 4U > 3U || (tables & 0x0fU) > 3U) return false;
          components[component].dc_table = (unsigned char)(tables >> 4U); components[component].ac_table = (unsigned char)(tables & 0x0fU); found = true;
        }
        if (!found) return false;
      }
      offset += segment;
      JpegBitReader reader = { bytes, length, offset, 0U, 0U };
      const unsigned mcu_x = (width + 8U * max_h - 1U) / (8U * max_h); const unsigned mcu_y = (height + 8U * max_v - 1U) / (8U * max_v);
      const uint64_t mcu_count = (uint64_t)mcu_x * (uint64_t)mcu_y;
      for (uint64_t mcu = 0U; mcu < mcu_count; mcu += 1U) {
        if (restart_interval > 0U && mcu > 0U && mcu % restart_interval == 0U) {
          unsigned restart = 0U; if (!jpeg_reader_marker(&reader, &restart) || restart < 0xd0U || restart > 0xd7U) {
            return false;
          }
          for (unsigned component = 0U; component < component_count; component += 1U) components[component].dc_prediction = 0;
        }
        for (unsigned component = 0U; component < component_count; component += 1U) {
          for (unsigned block = 0U; block < (unsigned)components[component].h * (unsigned)components[component].v; block += 1U) {
            if (!jpeg_decode_block(&reader, &dc_tables[components[component].dc_table], &ac_tables[components[component].ac_table], &components[component].dc_prediction)) {
              return false;
            }
          }
        }
      }
      unsigned end_marker = 0U; if (!jpeg_reader_marker(&reader, &end_marker) || end_marker != 0xd9U || reader.offset != length) {
        return false;
      }
      return true;
    }
    if (marker == 0xd9U || marker == 0xd8U || (marker >= 0xd0U && marker <= 0xd7U)) return false;
    if (offset + 2U > length) return false;
    const uint16_t segment = (uint16_t)(((uint16_t)bytes[offset] << 8U) | bytes[offset + 1U]);
    if (segment < 2U || offset + segment > length) return false;
    const unsigned char *data = bytes + offset + 2U; const size_t data_length = segment - 2U;
    if (marker == 0xc0U) {
      if (saw_frame || data_length < 6U || data[0] != 8U) return false;
      height = ((unsigned)data[1] << 8U) | data[2]; width = ((unsigned)data[3] << 8U) | data[4]; component_count = data[5];
      if (width == 0U || height == 0U || component_count == 0U || component_count > 4U || data_length != 6U + 3U * component_count) return false;
      for (unsigned component = 0U; component < component_count; component += 1U) {
        components[component].id = data[6U + component * 3U]; components[component].h = data[7U + component * 3U] >> 4U; components[component].v = data[7U + component * 3U] & 0x0fU;
        if (components[component].h == 0U || components[component].v == 0U || components[component].h > 4U || components[component].v > 4U) return false;
        if (components[component].id == 0U) return false;
        if (components[component].h > max_h) max_h = components[component].h; if (components[component].v > max_v) max_v = components[component].v;
      }
      saw_frame = true;
    } else if (marker == 0xc4U) {
      size_t inner = 0U;
      while (inner < data_length) {
        if (inner + 17U > data_length) return false;
        const unsigned table_info = data[inner++]; const unsigned table_class = table_info >> 4U; const unsigned table_id = table_info & 0x0fU;
        if (table_class > 1U || table_id > 3U) return false;
        unsigned char bits[16]; memcpy(bits, data + inner, sizeof(bits)); inner += sizeof(bits); size_t count = 0U; for (size_t index = 0U; index < sizeof(bits); index += 1U) count += bits[index];
        if (count == 0U || inner + count > data_length) return false;
        JpegHuffmanTable *table = table_class == 0U ? &dc_tables[table_id] : &ac_tables[table_id];
        if (!jpeg_huffman_build(table, bits, data + inner, count)) return false; inner += count;
      }
    } else if (marker == 0xddU) {
      if (data_length != 2U) return false; restart_interval = ((unsigned)data[0] << 8U) | data[1];
    } else if ((marker >= 0xc1U && marker <= 0xc3U) || (marker >= 0xc5U && marker <= 0xc7U) || (marker >= 0xc9U && marker <= 0xcbU) || (marker >= 0xcdU && marker <= 0xcfU)) {
      return false;
    }
    offset += segment;
  }
  return false;
}

static bool validate_jpeg_structure(const unsigned char *bytes, size_t length) {
  if (length < 4U || bytes[0] != 0xffU || bytes[1] != 0xd8U || bytes[length - 2U] != 0xffU || bytes[length - 1U] != 0xd9U) return false;
  size_t offset = 2U;
  unsigned frames = 0U;
  bool saw_scan = false;
  while (offset + 1U < length) {
    if (bytes[offset++] != 0xffU) return false;
    while (offset < length && bytes[offset] == 0xffU) offset += 1U;
    if (offset >= length) return false;
    const unsigned marker = bytes[offset++];
    if (marker == 0xd9U) return offset == length;
    if (marker == 0xdaU) { saw_scan = true; break; }
    if (marker == 0xd8U || (marker >= 0xd0U && marker <= 0xd7U)) continue;
    if (offset + 2U > length) return false;
    const uint16_t segment = (uint16_t)(((uint16_t)bytes[offset] << 8U) | bytes[offset + 1U]);
    if (segment < 2U || offset + segment > length) return false;
    const bool frame = (marker >= 0xc0U && marker <= 0xc3U) || (marker >= 0xc5U && marker <= 0xc7U) ||
      (marker >= 0xc9U && marker <= 0xcbU) || (marker >= 0xcdU && marker <= 0xcfU);
    if (frame) { frames += 1U; if (frames != 1U || segment < 7U) return false; }
    offset += segment;
  }
  if (!saw_scan || frames != 1U) return false;
  for (size_t index = offset; index + 1U < length - 2U; index += 1U) {
    if (bytes[index] == 0xffU && bytes[index + 1U] == 0xd9U) return false;
  }
  const bool entropy_valid = validate_jpeg_entropy(bytes, length);
  return entropy_valid;
}

static int decode_bytes(const unsigned char *bytes, size_t length, const char *kind) {
  if (bytes == NULL || length == 0U || length > MAX_BYTES ||
      (strcmp(kind, "png") == 0 && !validate_png_stream(bytes, length)) ||
      (strcmp(kind, "jpeg") == 0 && !validate_jpeg_structure(bytes, length))) {
    error_line("IMAGE_DECODE_FAILED"); return 4;
  }
  CFDataRef data = CFDataCreate(kCFAllocatorDefault, bytes, (CFIndex)length);
  CGImageSourceRef source = data ? CGImageSourceCreateWithData(data, NULL) : NULL;
  if (source == NULL || CGImageSourceGetCount(source) != 1U || !expected_type(source, kind) ||
      CGImageSourceGetStatus(source) != kCGImageStatusComplete) {
    if (source) CFRelease(source); if (data) CFRelease(data); error_line("IMAGE_DECODE_FAILED"); return 4;
  }
  CFDictionaryRef properties = CGImageSourceCopyPropertiesAtIndex(source, 0U, NULL);
  CFNumberRef widthNumber = properties ? CFDictionaryGetValue(properties, kCGImagePropertyPixelWidth) : NULL;
  CFNumberRef heightNumber = properties ? CFDictionaryGetValue(properties, kCGImagePropertyPixelHeight) : NULL;
  int width = 0, height = 0;
  if (widthNumber) (void)CFNumberGetValue(widthNumber, kCFNumberIntType, &width);
  if (heightNumber) (void)CFNumberGetValue(heightNumber, kCFNumberIntType, &height);
  if (width < 1 || height < 1 || (uint64_t)width > MAX_DIMENSION || (uint64_t)height > MAX_DIMENSION || (uint64_t)width * (uint64_t)height > MAX_PIXELS) {
    if (properties) CFRelease(properties); CFRelease(source); CFRelease(data); error_line("IMAGE_DIMENSIONS_INVALID"); return 5;
  }
  CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0U, NULL);
  CGColorSpaceRef color = image ? CGColorSpaceCreateDeviceRGB() : NULL;
  CGContextRef context = color ? CGBitmapContextCreate(NULL, (size_t)width, (size_t)height, 8U, 0U, color, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big) : NULL;
  if (context == NULL) {
    if (color) CGColorSpaceRelease(color); if (image) CGImageRelease(image); if (properties) CFRelease(properties); CFRelease(source); CFRelease(data); error_line("IMAGE_DECODE_FAILED"); return 6;
  }
  CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
  print_digest(bytes, length, (size_t)width, (size_t)height);
  CGContextRelease(context); CGColorSpaceRelease(color); CGImageRelease(image); if (properties) CFRelease(properties); CFRelease(source); CFRelease(data);
  return 0;
}

static bool read_line(char *buffer, size_t capacity) {
  if (fgets(buffer, (int)capacity, stdin) == NULL) return false;
  const size_t length = strlen(buffer);
  return length > 0U && length < capacity - 1U && buffer[length - 1U] == '\n';
}

static bool hex_decode(const char *value, unsigned char *out, size_t capacity, size_t *length_out) {
  const size_t length = strlen(value);
  if ((length % 2U) != 0U || length / 2U > capacity) return false;
  for (size_t index = 0U; index < length / 2U; index += 1U) {
    unsigned high = 0U, low = 0U;
    const char first = value[index * 2U]; const char second = value[index * 2U + 1U];
    if (first >= '0' && first <= '9') high = (unsigned)(first - '0'); else if (first >= 'a' && first <= 'f') high = (unsigned)(first - 'a' + 10); else return false;
    if (second >= '0' && second <= '9') low = (unsigned)(second - '0'); else if (second >= 'a' && second <= 'f') low = (unsigned)(second - 'a' + 10); else return false;
    out[index] = (unsigned char)((high << 4U) | low);
  }
  *length_out = length / 2U;
  return true;
}

static bool bundle_object_digest(const unsigned char *header, size_t header_length, const unsigned char *content, size_t content_length, char out[72]) {
  if (header_length > UINT32_MAX) return false;
  const char domain[] = "writcraft-snapshot-object/v1";
  unsigned char header_size[4]; unsigned char content_size[8]; unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  header_size[0] = (unsigned char)(header_length >> 24U); header_size[1] = (unsigned char)(header_length >> 16U); header_size[2] = (unsigned char)(header_length >> 8U); header_size[3] = (unsigned char)header_length;
  uint64_t size = (uint64_t)content_length;
  for (size_t index = 0U; index < 8U; index += 1U) { content_size[7U - index] = (unsigned char)(size & 0xffU); size >>= 8U; }
  CC_SHA256_CTX context; CC_SHA256_Init(&context); CC_SHA256_Update(&context, domain, (CC_LONG)(sizeof(domain) - 1U));
  unsigned char zero = 0U; CC_SHA256_Update(&context, &zero, 1U); CC_SHA256_Update(&context, header_size, sizeof(header_size));
  CC_SHA256_Update(&context, header, (CC_LONG)header_length); CC_SHA256_Update(&context, content_size, sizeof(content_size));
  CC_SHA256_Update(&context, content, (CC_LONG)content_length); CC_SHA256_Final(digest, &context);
  memcpy(out, "sha256:", 7U); for (size_t index = 0U; index < sizeof(digest); index += 1U) (void)snprintf(out + 7U + index * 2U, 3U, "%02x", digest[index]); out[71] = '\0';
  return true;
}

static bool entry_binding_digest(const char *snapshot_id, const char *file_id, const char *payload_digest, const char *object_digest, uint64_t offset, uint64_t length, char out[72]) {
  char canonical[4096];
  int size = snprintf(canonical, sizeof(canonical), "{\"bundleObjectDigest\":\"%s\",\"bundlePayloadSha256\":\"%s\",\"contentLength\":%" PRIu64 ",\"contentOffset\":%" PRIu64 ",\"fileId\":\"%s\",\"schema\":\"writcraft.snapshot-entry-binding/v1\",\"snapshotId\":\"%s\"}", object_digest, payload_digest, length, offset, file_id, snapshot_id);
  if (size < 0 || (size_t)size >= sizeof(canonical)) return false;
  const char domain[] = "writcraft-digest/v1"; const char schema_name[] = "writcraft.snapshot-entry-binding/v1"; unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_CTX context; CC_SHA256_Init(&context); CC_SHA256_Update(&context, domain, (CC_LONG)(sizeof(domain) - 1U)); unsigned char zero = 0U; CC_SHA256_Update(&context, &zero, 1U); CC_SHA256_Update(&context, schema_name, (CC_LONG)(sizeof(schema_name) - 1U)); CC_SHA256_Update(&context, &zero, 1U); CC_SHA256_Update(&context, canonical, (CC_LONG)size); CC_SHA256_Final(digest, &context);
  memcpy(out, "sha256:", 7U); for (size_t index = 0U; index < sizeof(digest); index += 1U) (void)snprintf(out + 7U + index * 2U, 3U, "%02x", digest[index]); out[71] = '\0'; return true;
}

static int decode_entry_fd(void) {
  char line[65536];
  if (!read_line(line, sizeof(line))) { error_line("IMAGE_PROTOCOL_INVALID"); return 2; }
  char *fields[11]; size_t count = 0U; char *cursor = line; char *save = NULL;
  for (char *field = strtok_r(cursor, "\t\n", &save); field != NULL && count < 11U; field = strtok_r(NULL, "\t\n", &save)) fields[count++] = field;
  if (count != 11U || strcmp(fields[0], "E") != 0 || !valid_hex_digest(fields[3]) || !valid_hex_digest(fields[4]) || !valid_hex_digest(fields[7]) || !valid_hex_digest(fields[9]) || (strcmp(fields[10], "png") != 0 && strcmp(fields[10], "jpeg") != 0)) { error_line("IMAGE_PROTOCOL_INVALID"); return 2; }
  uint64_t expected_offset = 0U, expected_length = 0U;
  if (!parse_u64_text(fields[5], &expected_offset) || !parse_u64_text(fields[6], &expected_length) || expected_length == 0U || expected_length > MAX_BYTES) { error_line("IMAGE_PROTOCOL_INVALID"); return 2; }
  unsigned char expected_header[1024 * 1024]; size_t expected_header_length = 0U;
  if (!hex_decode(fields[8], expected_header, sizeof(expected_header), &expected_header_length) || expected_header_length == 0U) { error_line("IMAGE_PROTOCOL_INVALID"); return 2; }
  int flags = fcntl(STDERR_FILENO, F_GETFL); // keep stdout/stderr protocol descriptors independent
  (void)flags;
  const int bundle_fd = 3;
  int access_flags = fcntl(bundle_fd, F_GETFL);
  struct stat value;
  if (access_flags < 0 || (access_flags & O_ACCMODE) != O_RDONLY || fstat(bundle_fd, &value) != 0 || !S_ISREG(value.st_mode) ||
      (value.st_mode & 0777) != 0600 || value.st_nlink != 1 || value.st_size < 48 || (uint64_t)value.st_size > 520U * 1024U * 1024U) { error_line("IMAGE_ENTRY_AUTHORITY_INVALID"); return 4; }
  const size_t bundle_length = (size_t)value.st_size;
  unsigned char *bundle = malloc(bundle_length);
  if (bundle == NULL || !read_exact_fd(bundle_fd, bundle, bundle_length, 0U)) { free(bundle); error_line("IMAGE_ENTRY_AUTHORITY_INVALID"); return 4; }
  static const unsigned char magic[] = {0x57U, 0x43U, 0x53U, 0x42U, 0x01U, 0x00U, 0x00U, 0x00U};
  static const unsigned char footer[] = {0x57U, 0x43U, 0x53U, 0x42U, 0x45U, 0x4eU, 0x44U, 0x01U};
  const size_t payload_end = bundle_length - sizeof(footer) - CC_SHA256_DIGEST_LENGTH;
  char payload_digest[72];
  unsigned char raw_digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bundle, (CC_LONG)payload_end, raw_digest); memcpy(payload_digest, "sha256:", 7U); for (size_t index = 0U; index < sizeof(raw_digest); index += 1U) (void)snprintf(payload_digest + 7U + index * 2U, 3U, "%02x", raw_digest[index]); payload_digest[71] = '\0';
  if (memcmp(bundle, magic, sizeof(magic)) != 0 || memcmp(bundle + payload_end + CC_SHA256_DIGEST_LENGTH, footer, sizeof(footer)) != 0 || memcmp(bundle + payload_end, raw_digest, sizeof(raw_digest)) != 0 || strcmp(payload_digest, fields[3]) != 0) { free(bundle); error_line("IMAGE_ENTRY_AUTHORITY_INVALID"); return 4; }
  const uint32_t manifest_length = read_u32_be(bundle + sizeof(magic));
  size_t offset = sizeof(magic) + 4U + manifest_length;
  if (offset + 4U > payload_end) { free(bundle); error_line("IMAGE_ENTRY_AUTHORITY_INVALID"); return 4; }
  const uint32_t entry_count = read_u32_be(bundle + offset); offset += 4U;
  bool found = false; const unsigned char *content = NULL; size_t content_length = 0U;
  for (uint32_t index = 0U; index < entry_count && offset + 4U <= payload_end; index += 1U) {
    const uint32_t header_length = read_u32_be(bundle + offset); offset += 4U;
    if (header_length == 0U || header_length > 1024U * 1024U || offset + header_length + 8U > payload_end) { free(bundle); error_line("IMAGE_ENTRY_AUTHORITY_INVALID"); return 4; }
    const unsigned char *header = bundle + offset; offset += header_length;
    const uint64_t length = read_u64_be(bundle + offset); offset += 8U;
    if (length > MAX_BYTES || offset + length > payload_end) { free(bundle); error_line("IMAGE_ENTRY_AUTHORITY_INVALID"); return 4; }
    if ((uint64_t)offset == expected_offset && length == expected_length && header_length == expected_header_length && memcmp(header, expected_header, expected_header_length) == 0) {
      found = true; content = bundle + offset; content_length = (size_t)length;
    }
    offset += (size_t)length;
  }
  if (!found || offset != payload_end || content == NULL) { free(bundle); error_line("IMAGE_ENTRY_AUTHORITY_INVALID"); return 4; }
  char content_digest[72]; sha256_text(content, content_length, content_digest);
  char object_digest[72];
  if (strcmp(content_digest, fields[9]) != 0 || !bundle_object_digest(expected_header, expected_header_length, content, content_length, object_digest) || strcmp(object_digest, fields[4]) != 0) { free(bundle); error_line("IMAGE_ENTRY_AUTHORITY_INVALID"); return 4; }
  char binding_digest[72];
  if (!entry_binding_digest(fields[1], fields[2], fields[3], fields[4], expected_offset, expected_length, binding_digest) || strcmp(binding_digest, fields[7]) != 0) { free(bundle); error_line("IMAGE_ENTRY_AUTHORITY_INVALID"); return 4; }
  const int result = decode_bytes(content, content_length, fields[10]);
  struct stat after;
  if (fstat(bundle_fd, &after) != 0 || after.st_dev != value.st_dev || after.st_ino != value.st_ino || after.st_size != value.st_size ||
      after.st_mtimespec.tv_sec != value.st_mtimespec.tv_sec || after.st_mtimespec.tv_nsec != value.st_mtimespec.tv_nsec ||
      after.st_ctimespec.tv_sec != value.st_ctimespec.tv_sec || after.st_ctimespec.tv_nsec != value.st_ctimespec.tv_nsec) { free(bundle); error_line("IMAGE_ENTRY_AUTHORITY_INVALID"); return 4; }
  free(bundle);
  return result;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "entry") == 0) {
    struct rlimit limit = { .rlim_cur = 1024ULL * 1024ULL * 1024ULL, .rlim_max = 1024ULL * 1024ULL * 1024ULL };
    (void)setrlimit(RLIMIT_AS, &limit);
    (void)alarm(5U);
    return decode_entry_fd();
  }
  if (argc != 2 || (strcmp(argv[1], "png") != 0 && strcmp(argv[1], "jpeg") != 0)) { error_line("IMAGE_PROTOCOL_INVALID"); return 2; }
  struct rlimit limit = { .rlim_cur = 1024ULL * 1024ULL * 1024ULL, .rlim_max = 1024ULL * 1024ULL * 1024ULL };
  (void)setrlimit(RLIMIT_AS, &limit);
  (void)alarm(5U);
  unsigned char *bytes = NULL;
  size_t length = 0U;
  if (!read_all(&bytes, &length)) { error_line("IMAGE_INPUT_INVALID"); return 3; }
  const int result = decode_bytes(bytes, length, argv[1]);
  free(bytes);
  return result;
}
