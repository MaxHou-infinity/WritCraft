#define _DARWIN_C_SOURCE

// Read-only project hash worker.
//
// fd 3 is a Main-owned, already-bound project-root directory.  The protocol
// intentionally accepts only relative paths and scanner identities; it never
// accepts an absolute path or a filesystem mutation request.
//
// Request (one strict LF-terminated line per record):
//   B<TAB>sequence<TAB>count
//   I<TAB>sequence<TAB>path-hex<TAB>max-bytes<TAB>leaf-identity
//     <TAB>ancestor-count<TAB>ancestor-identity...
//
// An identity is seven decimal fields: dev, ino, size, mode, nlink, mtimeNs,
// ctimeNs.  Ancestors exclude the already-bound project root and are ordered
// from its direct child to the final file's parent.  For example, `a/b.md`
// has one ancestor identity (`a`).  Responses are:
//   R<TAB>sequence<TAB>OK<TAB>sha256-hex<TAB>full-leaf-identity
//   R<TAB>sequence<TAB>ERR<TAB>PATH|IDENTITY|BUDGET|IO
//   E<TAB>sequence<TAB>OK
//   E<TAB>sequence<TAB>ERR<TAB>PROTOCOL
//
// Any malformed header/item is a protocol failure for the entire batch.  A
// valid item whose filesystem state races is represented by its own ERR line,
// allowing Main to mark that candidate unreadable while retaining a sound
// transport boundary.

#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define PROJECT_ROOT_FD 3
#define MAX_BATCH_ITEMS 5000U
#define MAX_BATCH_BYTES (64ULL * 1024ULL * 1024ULL)
#define MAX_ITEM_BYTES (5ULL * 1024ULL * 1024ULL)
#define HASH_CHUNK_BYTES (64U * 1024U)
#define MAX_PATH_BYTES 4096U
#define MAX_COMPONENTS 128U
#define IDENTITY_FIELDS 7U
#define MAX_FIELDS (12U + ((MAX_COMPONENTS - 1U) * IDENTITY_FIELDS))
#define MAX_LINE_BYTES 32768U

typedef struct {
  uintmax_t dev;
  uintmax_t ino;
  uintmax_t size;
  uintmax_t mode;
  uintmax_t nlink;
  intmax_t mtime_ns;
  intmax_t ctime_ns;
} Identity;

typedef struct {
  uint64_t sequence;
  uint64_t max_bytes;
  char path[MAX_PATH_BYTES + 1U];
  size_t component_count;
  Identity leaf;
  Identity ancestors[MAX_COMPONENTS - 1U];
} Item;

typedef enum {
  READ_EOF = 0,
  READ_LINE = 1,
  READ_INVALID = 2,
  READ_IO_ERROR = 3,
} ReadLineResult;

typedef enum {
  HASH_OK = 0,
  HASH_PATH = 1,
  HASH_IDENTITY = 2,
  HASH_BUDGET = 3,
  HASH_IO = 4,
} HashResult;

static bool write_line(const char *line) {
  return fputs(line, stdout) != EOF && fflush(stdout) == 0;
}

static bool write_batch_end(uint64_t sequence, const char *state, const char *reason) {
  char line[128];
  int length = reason == NULL
    ? snprintf(line, sizeof(line), "E\t%" PRIu64 "\t%s\n", sequence, state)
    : snprintf(line, sizeof(line), "E\t%" PRIu64 "\t%s\t%s\n", sequence, state, reason);
  return length > 0 && (size_t)length < sizeof(line) && write_line(line);
}

static bool write_item_error(uint64_t sequence, const char *reason) {
  char line[128];
  int length = snprintf(line, sizeof(line), "R\t%" PRIu64 "\tERR\t%s\n", sequence, reason);
  return length > 0 && (size_t)length < sizeof(line) && write_line(line);
}

static bool decimal_uintmax(const char *value, uintmax_t *out) {
  if (value == NULL || value[0] == '\0') return false;
  if (value[0] == '0' && value[1] != '\0') return false;
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor += 1) {
    if (*cursor < '0' || *cursor > '9') return false;
  }
  errno = 0;
  char *end = NULL;
  uintmax_t parsed = strtoumax(value, &end, 10);
  if (errno == ERANGE || end == NULL || *end != '\0') return false;
  *out = parsed;
  return true;
}

static bool decimal_intmax(const char *value, intmax_t *out) {
  if (value == NULL || value[0] == '\0') return false;
  const char *digits = value;
  if (*digits == '-') {
    digits += 1;
    if (*digits == '\0') return false;
  }
  if (*digits == '0' && digits[1] != '\0') return false;
  for (const unsigned char *cursor = (const unsigned char *)digits; *cursor != '\0'; cursor += 1) {
    if (*cursor < '0' || *cursor > '9') return false;
  }
  errno = 0;
  char *end = NULL;
  intmax_t parsed = strtoimax(value, &end, 10);
  if (errno == ERANGE || end == NULL || *end != '\0') return false;
  *out = parsed;
  return true;
}

static bool parse_identity(char **fields, size_t first, Identity *out) {
  return decimal_uintmax(fields[first], &out->dev) &&
    decimal_uintmax(fields[first + 1U], &out->ino) &&
    decimal_uintmax(fields[first + 2U], &out->size) &&
    decimal_uintmax(fields[first + 3U], &out->mode) &&
    decimal_uintmax(fields[first + 4U], &out->nlink) &&
    decimal_intmax(fields[first + 5U], &out->mtime_ns) &&
    decimal_intmax(fields[first + 6U], &out->ctime_ns);
}

static bool timespec_to_ns(struct timespec value, intmax_t *out) {
  if (value.tv_nsec < 0 || value.tv_nsec >= 1000000000L) return false;
  if (value.tv_sec > (INTMAX_MAX - value.tv_nsec) / 1000000000L ||
      value.tv_sec < (INTMAX_MIN + value.tv_nsec) / 1000000000L) {
    return false;
  }
  *out = ((intmax_t)value.tv_sec * 1000000000L) + value.tv_nsec;
  return true;
}

static bool identity_from_stat(const struct stat *value, Identity *out) {
  if (value->st_size < 0 ||
      !timespec_to_ns(value->st_mtimespec, &out->mtime_ns) ||
      !timespec_to_ns(value->st_ctimespec, &out->ctime_ns)) {
    return false;
  }
  out->dev = (uintmax_t)value->st_dev;
  out->ino = (uintmax_t)value->st_ino;
  out->size = (uintmax_t)value->st_size;
  out->mode = (uintmax_t)value->st_mode;
  out->nlink = (uintmax_t)value->st_nlink;
  return true;
}

static bool same_identity(const struct stat *actual, const Identity *expected) {
  Identity value;
  return identity_from_stat(actual, &value) &&
    value.dev == expected->dev &&
    value.ino == expected->ino &&
    value.size == expected->size &&
    value.mode == expected->mode &&
    value.nlink == expected->nlink &&
    value.mtime_ns == expected->mtime_ns &&
    value.ctime_ns == expected->ctime_ns;
}

static bool split_fields(char *line, char **fields, size_t capacity, size_t *count_out) {
  size_t count = 1U;
  if (capacity == 0U) return false;
  fields[0] = line;
  for (char *cursor = line; *cursor != '\0'; cursor += 1) {
    if (*cursor != '\t') continue;
    *cursor = '\0';
    if (count >= capacity) return false;
    fields[count] = cursor + 1;
    count += 1U;
  }
  for (size_t index = 0; index < count; index += 1U) {
    if (fields[index][0] == '\0') return false;
  }
  *count_out = count;
  return true;
}

static bool hex_value(char value, unsigned char *out) {
  if (value >= '0' && value <= '9') {
    *out = (unsigned char)(value - '0');
    return true;
  }
  if (value >= 'a' && value <= 'f') {
    *out = (unsigned char)(10 + value - 'a');
    return true;
  }
  return false;
}

static bool decode_path_hex(const char *encoded, char *out, size_t capacity) {
  size_t length = strlen(encoded);
  if (length == 0U || (length % 2U) != 0U || (length / 2U) > MAX_PATH_BYTES || capacity <= length / 2U) {
    return false;
  }
  for (size_t index = 0; index < length; index += 2U) {
    unsigned char high = 0;
    unsigned char low = 0;
    if (!hex_value(encoded[index], &high) || !hex_value(encoded[index + 1U], &low)) return false;
    unsigned char decoded = (unsigned char)((high << 4U) | low);
    if (decoded == '\0') return false;
    out[index / 2U] = (char)decoded;
  }
  out[length / 2U] = '\0';
  return true;
}

static bool safe_segment(const char *start, size_t length) {
  if (length == 0U || length > NAME_MAX) return false;
  if ((length == 1U && start[0] == '.') ||
      (length == 2U && start[0] == '.' && start[1] == '.')) {
    return false;
  }
  for (size_t index = 0U; index < length; index += 1U) {
    if (start[index] == '\\') return false;
  }
  return true;
}

static bool split_safe_path(const char *path, size_t *component_count_out) {
  size_t components = 0U;
  const char *segment = path;
  for (const char *cursor = path;; cursor += 1) {
    if (*cursor != '/' && *cursor != '\0') continue;
    if (!safe_segment(segment, (size_t)(cursor - segment))) return false;
    components += 1U;
    if (components > MAX_COMPONENTS) return false;
    if (*cursor == '\0') break;
    segment = cursor + 1;
  }
  *component_count_out = components;
  return true;
}

static ReadLineResult read_protocol_line(char *buffer, size_t capacity, size_t *length_out) {
  if (capacity < 2U) return READ_IO_ERROR;
  memset(buffer, 0, capacity);
  if (fgets(buffer, (int)capacity, stdin) == NULL) {
    return feof(stdin) ? READ_EOF : READ_IO_ERROR;
  }
  char *newline = memchr(buffer, '\n', capacity);
  if (newline == NULL) return READ_INVALID;
  if (memchr(buffer, '\0', (size_t)(newline - buffer)) != NULL ||
      newline == buffer || (newline > buffer && newline[-1] == '\r')) {
    return READ_INVALID;
  }
  *newline = '\0';
  *length_out = (size_t)(newline - buffer);
  return READ_LINE;
}

static bool parse_header(char *line, uint64_t *sequence_out, size_t *count_out) {
  char *fields[3];
  size_t field_count = 0U;
  uintmax_t sequence = 0;
  uintmax_t count = 0;
  if (!split_fields(line, fields, 3U, &field_count) || field_count != 3U || strcmp(fields[0], "B") != 0 ||
      !decimal_uintmax(fields[1], &sequence) || !decimal_uintmax(fields[2], &count) ||
      sequence > UINT64_MAX || count > MAX_BATCH_ITEMS) {
    return false;
  }
  *sequence_out = (uint64_t)sequence;
  *count_out = (size_t)count;
  return true;
}

static bool parse_item(char *line, uint64_t batch_sequence, Item *out) {
  char *fields[MAX_FIELDS];
  size_t field_count = 0U;
  uintmax_t sequence = 0;
  uintmax_t max_bytes = 0;
  uintmax_t ancestor_count = 0;
  if (!split_fields(line, fields, MAX_FIELDS, &field_count) || field_count < 12U || strcmp(fields[0], "I") != 0 ||
      !decimal_uintmax(fields[1], &sequence) || sequence != batch_sequence ||
      !decimal_uintmax(fields[3], &max_bytes) || max_bytes > MAX_ITEM_BYTES ||
      !parse_identity(fields, 4U, &out->leaf) ||
      !decimal_uintmax(fields[11], &ancestor_count) || ancestor_count >= MAX_COMPONENTS ||
      field_count != 12U + ((size_t)ancestor_count * IDENTITY_FIELDS) ||
      !decode_path_hex(fields[2], out->path, sizeof(out->path)) ||
      !split_safe_path(out->path, &out->component_count) ||
      out->component_count == 0U || ancestor_count != out->component_count - 1U ||
      out->leaf.size > max_bytes || !S_ISREG((mode_t)out->leaf.mode)) {
    return false;
  }
  out->sequence = (uint64_t)sequence;
  out->max_bytes = (uint64_t)max_bytes;
  for (size_t index = 0U; index < (size_t)ancestor_count; index += 1U) {
    if (!parse_identity(fields, 12U + (index * IDENTITY_FIELDS), &out->ancestors[index]) ||
        !S_ISDIR((mode_t)out->ancestors[index].mode)) {
      return false;
    }
  }
  return true;
}

static int duplicate_root(void) {
  int duplicate = fcntl(PROJECT_ROOT_FD, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return -1;
  struct stat root;
  if (fstat(duplicate, &root) != 0 || !S_ISDIR(root.st_mode)) {
    (void)close(duplicate);
    return -1;
  }
  return duplicate;
}

static HashResult open_checked_leaf(const Item *item, int *leaf_out) {
  int current = duplicate_root();
  if (current < 0) return HASH_IO;
  char working_path[MAX_PATH_BYTES + 1U];
  memcpy(working_path, item->path, sizeof(working_path));
  char *segment = working_path;
  size_t index = 0U;

  while (index + 1U < item->component_count) {
    char *next = strchr(segment, '/');
    if (next == NULL) {
      (void)close(current);
      return HASH_PATH;
    }
    *next = '\0';
    int child = openat(
      current,
      segment,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC
    );
    if (child < 0) {
      (void)close(current);
      return HASH_PATH;
    }
    struct stat stat_value;
    bool matches = fstat(child, &stat_value) == 0 && same_identity(&stat_value, &item->ancestors[index]);
    (void)close(current);
    if (!matches) {
      (void)close(child);
      return HASH_IDENTITY;
    }
    current = child;
    segment = next + 1;
    index += 1U;
  }

  int leaf = openat(current, segment, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  (void)close(current);
  if (leaf < 0) return HASH_PATH;
  struct stat leaf_stat;
  bool matches = fstat(leaf, &leaf_stat) == 0 && same_identity(&leaf_stat, &item->leaf);
  if (!matches) {
    (void)close(leaf);
    return HASH_IDENTITY;
  }
  *leaf_out = leaf;
  return HASH_OK;
}

static HashResult hash_item(const Item *item, char digest_hex[(CC_SHA256_DIGEST_LENGTH * 2U) + 1U]) {
  if (item->max_bytes > MAX_ITEM_BYTES || item->leaf.size > item->max_bytes ||
      item->leaf.size > MAX_BATCH_BYTES) {
    return HASH_BUDGET;
  }
  int leaf = -1;
  HashResult opened = open_checked_leaf(item, &leaf);
  if (opened != HASH_OK) return opened;

  unsigned char buffer[HASH_CHUNK_BYTES];
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  uintmax_t remaining = item->leaf.size;
  HashResult result = HASH_OK;
  while (remaining > 0U) {
    size_t requested = remaining > HASH_CHUNK_BYTES ? HASH_CHUNK_BYTES : (size_t)remaining;
    ssize_t received = read(leaf, buffer, requested);
    if (received <= 0 || (size_t)received > requested) {
      result = HASH_IO;
      break;
    }
    CC_SHA256_Update(&context, buffer, (CC_LONG)received);
    remaining -= (uintmax_t)received;
  }

  struct stat after_read;
  if (result == HASH_OK && (fstat(leaf, &after_read) != 0 || !same_identity(&after_read, &item->leaf))) {
    result = HASH_IDENTITY;
  }
  if (close(leaf) != 0 && result == HASH_OK) result = HASH_IO;
  if (result != HASH_OK) return result;

  // Re-open every component from the fixed root after the read.  This catches
  // a replacement of the final path or any checked ancestor while the content
  // fd was held, without falling back to a path traversal outside root fd.
  int rechecked = -1;
  HashResult reopened = open_checked_leaf(item, &rechecked);
  if (reopened != HASH_OK) return reopened;
  if (close(rechecked) != 0) return HASH_IO;

  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  for (size_t index = 0U; index < CC_SHA256_DIGEST_LENGTH; index += 1U) {
    (void)snprintf(digest_hex + (index * 2U), 3U, "%02x", digest[index]);
  }
  digest_hex[CC_SHA256_DIGEST_LENGTH * 2U] = '\0';
  return HASH_OK;
}

static const char *hash_result_name(HashResult result) {
  switch (result) {
    case HASH_PATH: return "PATH";
    case HASH_IDENTITY: return "IDENTITY";
    case HASH_BUDGET: return "BUDGET";
    case HASH_IO: return "IO";
    case HASH_OK: return "OK";
  }
  return "IO";
}

static bool write_item_success(uint64_t sequence, const char *digest, const Identity *identity) {
  char line[512];
  int length = snprintf(
    line,
    sizeof(line),
    "R\t%" PRIu64 "\tOK\t%s\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX
    "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIdMAX "\t%" PRIdMAX "\n",
    sequence,
    digest,
    identity->dev,
    identity->ino,
    identity->size,
    identity->mode,
    identity->nlink,
    identity->mtime_ns,
    identity->ctime_ns
  );
  return length > 0 && (size_t)length < sizeof(line) && write_line(line);
}

int main(void) {
  char line[MAX_LINE_BYTES];
  uint64_t batch_sequence = 0U;
  bool success = true;

  while (success) {
    size_t line_length = 0U;
    ReadLineResult read_header = read_protocol_line(line, sizeof(line), &line_length);
    (void)line_length;
    if (read_header == READ_EOF) break;
    if (read_header != READ_LINE) {
      success = write_batch_end(0U, "ERR", "PROTOCOL");
      break;
    }

    size_t count = 0U;
    if (!parse_header(line, &batch_sequence, &count)) {
      success = write_batch_end(0U, "ERR", "PROTOCOL");
      break;
    }

    uint64_t batch_bytes = 0U;
    bool protocol_error = false;
    for (size_t index = 0U; index < count; index += 1U) {
      ReadLineResult read_item = read_protocol_line(line, sizeof(line), &line_length);
      (void)line_length;
      Item item;
      if (read_item != READ_LINE || !parse_item(line, batch_sequence, &item) ||
          item.leaf.size > MAX_BATCH_BYTES - batch_bytes) {
        success = write_batch_end(batch_sequence, "ERR", "PROTOCOL");
        protocol_error = true;
        break;
      }
      batch_bytes += item.leaf.size;

      char digest[(CC_SHA256_DIGEST_LENGTH * 2U) + 1U];
      HashResult result = hash_item(&item, digest);
      if (result == HASH_OK) success = write_item_success(item.sequence, digest, &item.leaf);
      else success = write_item_error(item.sequence, hash_result_name(result));
      if (!success) break;
    }
    if (!success || protocol_error) {
      if (protocol_error) success = false;
      break;
    }
    success = write_batch_end(batch_sequence, "OK", NULL);
  }

  if (close(PROJECT_ROOT_FD) != 0) success = false;
  return success ? 0 : 1;
}
