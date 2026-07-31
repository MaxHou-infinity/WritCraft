#define _DARWIN_C_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef RENAME_EXCL
#define RENAME_EXCL 0x00000004
#endif

#define PROJECT_ROOT_FD 3
#define RECEIPT_FD 4
#define RECOVERY_FD 4
#define INPUT_CAPACITY 8192
#define OPERATION_PREFIX "wst_"
#define STAGE_PREFIX ".writcraft-structure-stage-"
#define TARGET_NAME "chapters"
#define RECEIPT_SCHEMA "writcraft.structure-stage-receipt/v1"

typedef struct {
  bool exists;
  struct stat value;
} OptionalStat;

static bool restore_quarantine(
  int parent_fd,
  const char *quarantine,
  const char *original
);

static void print_failure(void) {
  fputs("{\"ok\":false,\"errno\":null}\n", stdout);
}

static bool read_request(char *buffer, size_t capacity, size_t *length_out) {
  size_t length = fread(buffer, 1, capacity - 1, stdin);
  if (ferror(stdin) || (!feof(stdin) && length == capacity - 1)) return false;
  if (memchr(buffer, '\0', length) != NULL) return false;
  buffer[length] = '\0';
  *length_out = length;
  return true;
}

static bool lower_hex_exact(const char *value, size_t length) {
  if (strlen(value) != length) return false;
  for (size_t index = 0; index < length; index += 1) {
    unsigned char character = (unsigned char)value[index];
    if (!((character >= '0' && character <= '9') ||
          (character >= 'a' && character <= 'f'))) {
      return false;
    }
  }
  return true;
}

static bool valid_operation_id(const char *value) {
  return strncmp(value, OPERATION_PREFIX, sizeof(OPERATION_PREFIX) - 1) == 0 &&
    lower_hex_exact(value + sizeof(OPERATION_PREFIX) - 1, 48);
}

static bool valid_stage_name(const char *value) {
  return strncmp(value, STAGE_PREFIX, sizeof(STAGE_PREFIX) - 1) == 0 &&
    lower_hex_exact(value + sizeof(STAGE_PREFIX) - 1, 48);
}

static bool valid_directory_name(const char *value) {
  return valid_stage_name(value) || strcmp(value, TARGET_NAME) == 0;
}

static bool valid_file_name(const char *value) {
  return strlen(value) == 5 &&
    value[0] == '0' &&
    value[1] >= '1' &&
    value[1] <= '8' &&
    strcmp(value + 2, ".md") == 0;
}

static bool digits_only(const char *value) {
  if (value[0] == '\0') return false;
  for (const unsigned char *cursor = (const unsigned char *)value;
       *cursor;
       cursor += 1) {
    if (*cursor < '0' || *cursor > '9') return false;
  }
  return true;
}

static bool trusted_root_is_ready(void) {
  struct stat root;
  int flags = fcntl(PROJECT_ROOT_FD, F_GETFL);
  return flags >= 0 &&
    (flags & O_ACCMODE) == O_RDONLY &&
    fstat(PROJECT_ROOT_FD, &root) == 0 &&
    S_ISDIR(root.st_mode);
}

static bool receipt_is_ready(void) {
  struct stat receipt;
  int flags = fcntl(RECEIPT_FD, F_GETFL);
  return flags >= 0 &&
    (flags & O_ACCMODE) == O_RDWR &&
    fstat(RECEIPT_FD, &receipt) == 0 &&
    S_ISREG(receipt.st_mode) &&
    receipt.st_uid == geteuid() &&
    (receipt.st_mode & 0777) == 0600 &&
    receipt.st_nlink == 1 &&
    receipt.st_size == 0;
}

static bool recovery_is_ready(void) {
  struct stat recovery;
  int flags = fcntl(RECOVERY_FD, F_GETFL);
  return flags >= 0 &&
    (flags & O_ACCMODE) == O_RDONLY &&
    fstat(RECOVERY_FD, &recovery) == 0 &&
    S_ISDIR(recovery.st_mode) &&
    recovery.st_uid == geteuid() &&
    (recovery.st_mode & 0777) == 0700;
}

static void identity_strings(
  const struct stat *value,
  char *device,
  size_t device_capacity,
  char *inode,
  size_t inode_capacity
) {
  snprintf(device, device_capacity, "%llu", (unsigned long long)value->st_dev);
  snprintf(inode, inode_capacity, "%llu", (unsigned long long)value->st_ino);
}

static bool write_all_at(int fd, const char *payload, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = pwrite(
      fd,
      payload + offset,
      length - offset,
      (off_t)offset
    );
    if (written <= 0) return false;
    offset += (size_t)written;
  }
  return true;
}

static int base64_value(unsigned char character) {
  if (character >= 'A' && character <= 'Z') return character - 'A';
  if (character >= 'a' && character <= 'z') return character - 'a' + 26;
  if (character >= '0' && character <= '9') return character - '0' + 52;
  if (character == '+') return 62;
  if (character == '/') return 63;
  return -1;
}

static bool decode_base64(
  const char *encoded,
  unsigned char *decoded,
  size_t capacity,
  size_t *length_out
) {
  size_t length = strlen(encoded);
  if (length == 0 || length % 4 != 0) return false;
  size_t output = 0;
  for (size_t index = 0; index < length; index += 4) {
    int a = base64_value((unsigned char)encoded[index]);
    int b = base64_value((unsigned char)encoded[index + 1]);
    int c = encoded[index + 2] == '=' ? -2 :
      base64_value((unsigned char)encoded[index + 2]);
    int d = encoded[index + 3] == '=' ? -2 :
      base64_value((unsigned char)encoded[index + 3]);
    bool last = index + 4 == length;
    if (a < 0 || b < 0 || c == -1 || d == -1 ||
        (c == -2 && d != -2) ||
        (!last && (c == -2 || d == -2))) {
      return false;
    }
    size_t bytes = c == -2 ? 1 : (d == -2 ? 2 : 3);
    if (output + bytes > capacity) return false;
    decoded[output++] = (unsigned char)((a << 2) | (b >> 4));
    if (bytes >= 2) {
      decoded[output++] = (unsigned char)(((b & 15) << 4) | (c >> 2));
    }
    if (bytes == 3) {
      decoded[output++] = (unsigned char)(((c & 3) << 6) | d);
    }
    if ((bytes == 1 && (b & 15) != 0) ||
        (bytes == 2 && (c & 3) != 0)) {
      return false;
    }
  }
  *length_out = output;
  return true;
}

static bool read_exact_bytes(
  int fd,
  const unsigned char *expected,
  size_t length
) {
  unsigned char buffer[1024];
  size_t offset = 0;
  while (offset < length) {
    size_t wanted = length - offset;
    if (wanted > sizeof(buffer)) wanted = sizeof(buffer);
    ssize_t count = pread(fd, buffer, wanted, (off_t)offset);
    if (count <= 0 ||
        memcmp(buffer, expected + offset, (size_t)count) != 0) {
      return false;
    }
    offset += (size_t)count;
  }
  unsigned char extra;
  return pread(fd, &extra, 1, (off_t)length) == 0;
}

static bool write_receipt(
  const char *operation_id,
  const char *stage,
  const struct stat *value
) {
  char device[32];
  char inode[32];
  char payload[512];
  identity_strings(value, device, sizeof(device), inode, sizeof(inode));
  int length = snprintf(
    payload,
    sizeof(payload),
    "{\"schema\":\"%s\",\"operationId\":\"%s\",\"stage\":\"%s\","
    "\"dev\":\"%s\",\"ino\":\"%s\",\"mode\":%u}\n",
    RECEIPT_SCHEMA,
    operation_id,
    stage,
    device,
    inode,
    (unsigned int)(value->st_mode & 0777)
  );
  return length > 0 &&
    (size_t)length < sizeof(payload) &&
    write_all_at(RECEIPT_FD, payload, (size_t)length) &&
    ftruncate(RECEIPT_FD, (off_t)length) == 0 &&
    fsync(RECEIPT_FD) == 0;
}

static bool directory_is_empty(int directory_fd) {
  int scan_fd = fcntl(directory_fd, F_DUPFD_CLOEXEC, 0);
  if (scan_fd < 0) return false;
  DIR *directory = fdopendir(scan_fd);
  if (directory == NULL) {
    (void)close(scan_fd);
    return false;
  }
  bool empty = true;
  errno = 0;
  for (struct dirent *entry = readdir(directory);
       entry != NULL;
       entry = readdir(directory)) {
    if (strcmp(entry->d_name, ".") != 0 &&
        strcmp(entry->d_name, "..") != 0) {
      empty = false;
      break;
    }
  }
  int scan_error = errno;
  int close_result = closedir(directory);
  return empty && scan_error == 0 && close_result == 0;
}

static bool exact_private_empty_stage(
  int stage_fd,
  const struct stat *opened,
  const struct stat *at_path
) {
  return S_ISDIR(opened->st_mode) &&
    S_ISDIR(at_path->st_mode) &&
    opened->st_dev == at_path->st_dev &&
    opened->st_ino == at_path->st_ino &&
    (opened->st_mode & 0777) == 0700 &&
    (at_path->st_mode & 0777) == 0700 &&
    opened->st_uid == geteuid() &&
    at_path->st_uid == geteuid() &&
    opened->st_gid == at_path->st_gid &&
    directory_is_empty(stage_fd);
}

static int open_expected_directory(
  const char *name,
  const char *expected_device,
  const char *expected_inode,
  struct stat *opened_out
) {
  int directory_fd = openat(
    PROJECT_ROOT_FD,
    name,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW
  );
  if (directory_fd < 0) return -1;
  struct stat opened;
  struct stat at_path;
  char actual_device[32];
  char actual_inode[32];
  bool valid = fstat(directory_fd, &opened) == 0 &&
    fstatat(PROJECT_ROOT_FD, name, &at_path, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISDIR(opened.st_mode) &&
    S_ISDIR(at_path.st_mode) &&
    opened.st_dev == at_path.st_dev &&
    opened.st_ino == at_path.st_ino &&
    (opened.st_mode & 0777) == 0700 &&
    (at_path.st_mode & 0777) == 0700 &&
    opened.st_uid == geteuid() &&
    at_path.st_uid == geteuid();
  if (valid) {
    identity_strings(
      &opened,
      actual_device,
      sizeof(actual_device),
      actual_inode,
      sizeof(actual_inode)
    );
    valid = strcmp(actual_device, expected_device) == 0 &&
      strcmp(actual_inode, expected_inode) == 0;
  }
  if (!valid) {
    (void)close(directory_fd);
    return -1;
  }
  *opened_out = opened;
  return directory_fd;
}

static bool exact_private_file(
  int directory_fd,
  const char *name,
  const char *expected_device,
  const char *expected_inode,
  const unsigned char *expected_bytes,
  size_t expected_length
) {
  int file_fd = openat(directory_fd, name, O_RDONLY | O_NOFOLLOW);
  if (file_fd < 0) return false;
  struct stat opened;
  struct stat at_path;
  char actual_device[32];
  char actual_inode[32];
  bool valid = fstat(file_fd, &opened) == 0 &&
    fstatat(directory_fd, name, &at_path, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISREG(opened.st_mode) &&
    S_ISREG(at_path.st_mode) &&
    opened.st_dev == at_path.st_dev &&
    opened.st_ino == at_path.st_ino &&
    opened.st_uid == geteuid() &&
    at_path.st_uid == geteuid() &&
    opened.st_nlink == 1 &&
    at_path.st_nlink == 1 &&
    (opened.st_mode & 0777) == 0600 &&
    (at_path.st_mode & 0777) == 0600 &&
    opened.st_size == (off_t)expected_length &&
    at_path.st_size == (off_t)expected_length;
  if (valid) {
    identity_strings(
      &opened,
      actual_device,
      sizeof(actual_device),
      actual_inode,
      sizeof(actual_inode)
    );
    valid = strcmp(actual_device, expected_device) == 0 &&
      strcmp(actual_inode, expected_inode) == 0 &&
      read_exact_bytes(file_fd, expected_bytes, expected_length);
  }
  int close_result = close(file_fd);
  return valid && close_result == 0;
}

static bool quarantine_remove_owned_file(
  int directory_fd,
  const char *name,
  const struct stat *expected
) {
  char device[32];
  char inode[32];
  identity_strings(expected, device, sizeof(device), inode, sizeof(inode));
  char quarantine[96];
  int length = snprintf(
    quarantine,
    sizeof(quarantine),
    ".writcraft-write-cleanup-%s-%s",
    name,
    inode
  );
  if (length <= 0 || (size_t)length >= sizeof(quarantine) ||
      renameatx_np(
        directory_fd,
        name,
        directory_fd,
        quarantine,
        RENAME_EXCL
      ) != 0) {
    return false;
  }
  int file_fd = openat(directory_fd, quarantine, O_RDONLY | O_NOFOLLOW);
  struct stat opened;
  struct stat at_path;
  bool exact = file_fd >= 0 &&
    fstat(file_fd, &opened) == 0 &&
    fstatat(directory_fd, quarantine, &at_path, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISREG(opened.st_mode) &&
    opened.st_dev == expected->st_dev &&
    opened.st_ino == expected->st_ino &&
    at_path.st_dev == expected->st_dev &&
    at_path.st_ino == expected->st_ino;
  if (file_fd >= 0) (void)close(file_fd);
  if (!exact) {
    (void)restore_quarantine(directory_fd, quarantine, name);
    (void)fsync(directory_fd);
    return false;
  }
  return unlinkat(directory_fd, quarantine, 0) == 0 &&
    fsync(directory_fd) == 0;
}

// mkdirat does not atomically return the created directory fd. A same-UID
// writer could replace the new name with an indistinguishable owned, empty,
// 0700 directory before openat. The identity checks below prevent deleting or
// publishing a later visible replacement, but do not close that pre-ownership
// mkdirat -> openat residual.
static void remove_known_empty_stage_if_unchanged(
  const char *stage,
  const struct stat *opened
) {
  struct stat current;
  if (fstatat(
        PROJECT_ROOT_FD,
        stage,
        &current,
        AT_SYMLINK_NOFOLLOW
      ) != 0 ||
      !S_ISDIR(current.st_mode) ||
      current.st_dev != opened->st_dev ||
      current.st_ino != opened->st_ino) {
    return;
  }
  int stage_fd = openat(
    PROJECT_ROOT_FD,
    stage,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW
  );
  if (stage_fd < 0) return;
  struct stat reopened;
  bool removable = fstat(stage_fd, &reopened) == 0 &&
    reopened.st_dev == opened->st_dev &&
    reopened.st_ino == opened->st_ino &&
    directory_is_empty(stage_fd);
  (void)close(stage_fd);
  if (removable &&
      unlinkat(PROJECT_ROOT_FD, stage, AT_REMOVEDIR) == 0) {
    (void)fsync(PROJECT_ROOT_FD);
  }
}

static bool inspect_at(const char *name, OptionalStat *result) {
  memset(result, 0, sizeof(*result));
  if (fstatat(
        PROJECT_ROOT_FD,
        name,
        &result->value,
        AT_SYMLINK_NOFOLLOW
      ) == 0) {
    result->exists = true;
    return true;
  }
  return errno == ENOENT;
}

static void print_optional_identity(const OptionalStat *value) {
  if (!value->exists) {
    fputs("null", stdout);
    return;
  }
  char device[32];
  char inode[32];
  identity_strings(
    &value->value,
    device,
    sizeof(device),
    inode,
    sizeof(inode)
  );
  printf(
    "{\"type\":\"%s\",\"dev\":\"%s\",\"ino\":\"%s\",\"mode\":%u}",
    S_ISDIR(value->value.st_mode) ? "directory" : "other",
    device,
    inode,
    (unsigned int)(value->value.st_mode & 0777)
  );
}

static bool parse_reserve(
  const char *request,
  size_t length,
  char *operation_id,
  char *stage
) {
  int consumed = 0;
  int matched = sscanf(
    request,
    "{\"mode\":\"reserve\",\"operationId\":\"%63[^\"]\","
    "\"stage\":\"%127[^\"]\"}%n",
    operation_id,
    stage,
    &consumed
  );
  return matched == 2 &&
    consumed == (int)length &&
    valid_operation_id(operation_id) &&
    valid_stage_name(stage);
}

static bool parse_inspect(
  const char *request,
  size_t length,
  char *stage,
  char *target
) {
  int consumed = 0;
  int matched = sscanf(
    request,
    "{\"mode\":\"inspect\",\"stage\":\"%127[^\"]\","
    "\"target\":\"%31[^\"]\"}%n",
    stage,
    target,
    &consumed
  );
  return matched == 2 &&
    consumed == (int)length &&
    valid_stage_name(stage) &&
    strcmp(target, TARGET_NAME) == 0;
}

static bool parse_publish(
  const char *request,
  size_t length,
  char *stage,
  char *target,
  char *expected_device,
  char *expected_inode
) {
  int consumed = 0;
  int matched = sscanf(
    request,
    "{\"mode\":\"publish\",\"stage\":\"%127[^\"]\","
    "\"target\":\"%31[^\"]\",\"dev\":\"%31[0-9]\","
    "\"ino\":\"%31[0-9]\"}%n",
    stage,
    target,
    expected_device,
    expected_inode,
    &consumed
  );
  return matched == 4 &&
    consumed == (int)length &&
    valid_stage_name(stage) &&
    strcmp(target, TARGET_NAME) == 0 &&
    digits_only(expected_device) &&
    digits_only(expected_inode);
}

static bool parse_file_request(
  const char *request,
  size_t length,
  const char *mode,
  char *directory,
  char *expected_device,
  char *expected_inode,
  char *name,
  char *content_base64
) {
  int consumed = 0;
  char actual_mode[16] = {0};
  int matched = sscanf(
    request,
    "{\"mode\":\"%15[^\"]\",\"directory\":\"%127[^\"]\","
    "\"dev\":\"%31[0-9]\",\"ino\":\"%31[0-9]\","
    "\"name\":\"%15[^\"]\",\"contentBase64\":\"%2047[^\"]\"}%n",
    actual_mode,
    directory,
    expected_device,
    expected_inode,
    name,
    content_base64,
    &consumed
  );
  return matched == 6 &&
    consumed == (int)length &&
    strcmp(actual_mode, mode) == 0 &&
    valid_directory_name(directory) &&
    digits_only(expected_device) &&
    digits_only(expected_inode) &&
    valid_file_name(name);
}

static bool parse_seal(
  const char *request,
  size_t length,
  char *directory,
  char *expected_device,
  char *expected_inode,
  int *count
) {
  int consumed = 0;
  int matched = sscanf(
    request,
    "{\"mode\":\"seal\",\"directory\":\"%127[^\"]\","
    "\"dev\":\"%31[0-9]\",\"ino\":\"%31[0-9]\","
    "\"count\":%d}%n",
    directory,
    expected_device,
    expected_inode,
    count,
    &consumed
  );
  return matched == 4 &&
    consumed == (int)length &&
    valid_directory_name(directory) &&
    digits_only(expected_device) &&
    digits_only(expected_inode) &&
    *count >= 0 &&
    *count <= 8;
}

static bool parse_remove_file(
  const char *request,
  size_t length,
  char *stage,
  char *expected_device,
  char *expected_inode,
  char *name,
  char *file_device,
  char *file_inode,
  char *content_base64
) {
  int consumed = 0;
  int matched = sscanf(
    request,
    "{\"mode\":\"remove\",\"stage\":\"%127[^\"]\","
    "\"dev\":\"%31[0-9]\",\"ino\":\"%31[0-9]\","
    "\"name\":\"%15[^\"]\",\"fileDev\":\"%31[0-9]\","
    "\"fileIno\":\"%31[0-9]\",\"contentBase64\":\"%2047[^\"]\"}%n",
    stage,
    expected_device,
    expected_inode,
    name,
    file_device,
    file_inode,
    content_base64,
    &consumed
  );
  return matched == 7 &&
    consumed == (int)length &&
    valid_stage_name(stage) &&
    digits_only(expected_device) &&
    digits_only(expected_inode) &&
    valid_file_name(name) &&
    digits_only(file_device) &&
    digits_only(file_inode);
}

static bool parse_cleanup_stage(
  const char *request,
  size_t length,
  char *stage,
  char *expected_device,
  char *expected_inode
) {
  int consumed = 0;
  int matched = sscanf(
    request,
    "{\"mode\":\"cleanupStage\",\"stage\":\"%127[^\"]\","
    "\"dev\":\"%31[0-9]\",\"ino\":\"%31[0-9]\"}%n",
    stage,
    expected_device,
    expected_inode,
    &consumed
  );
  return matched == 3 &&
    consumed == (int)length &&
    valid_stage_name(stage) &&
    digits_only(expected_device) &&
    digits_only(expected_inode);
}

static bool parse_cleanup_controls(
  const char *request,
  size_t length,
  char *marker_device,
  char *marker_inode,
  char *receipt_device,
  char *receipt_inode
) {
  int consumed = 0;
  int matched = sscanf(
    request,
    "{\"mode\":\"cleanupControls\",\"markerDev\":\"%31[0-9]\","
    "\"markerIno\":\"%31[0-9]\",\"receiptDev\":\"%31[0-9]\","
    "\"receiptIno\":\"%31[0-9]\"}%n",
    marker_device,
    marker_inode,
    receipt_device,
    receipt_inode,
    &consumed
  );
  return matched == 4 &&
    consumed == (int)length &&
    digits_only(marker_device) &&
    digits_only(marker_inode) &&
    digits_only(receipt_device) &&
    digits_only(receipt_inode);
}

static bool exact_directory_names(int directory_fd, int count) {
  bool seen[8] = {false, false, false, false, false, false, false, false};
  int scan_fd = fcntl(directory_fd, F_DUPFD_CLOEXEC, 0);
  if (scan_fd < 0) return false;
  DIR *directory = fdopendir(scan_fd);
  if (directory == NULL) {
    (void)close(scan_fd);
    return false;
  }
  bool valid = true;
  int observed = 0;
  errno = 0;
  for (struct dirent *entry = readdir(directory);
       entry != NULL;
       entry = readdir(directory)) {
    if (strcmp(entry->d_name, ".") == 0 ||
        strcmp(entry->d_name, "..") == 0) {
      continue;
    }
    if (!valid_file_name(entry->d_name)) {
      valid = false;
      break;
    }
    int index = entry->d_name[1] - '1';
    if (index < 0 || index >= count || seen[index]) {
      valid = false;
      break;
    }
    seen[index] = true;
    observed += 1;
  }
  int scan_error = errno;
  int close_result = closedir(directory);
  if (!valid || scan_error != 0 || close_result != 0 || observed != count) {
    return false;
  }
  for (int index = 0; index < count; index += 1) {
    if (!seen[index]) return false;
  }
  return true;
}

static int write_stage_file(
  const char *stage,
  const char *expected_device,
  const char *expected_inode,
  const char *name,
  const char *content_base64
) {
  unsigned char bytes[2048];
  size_t length = 0;
  if (!decode_base64(content_base64, bytes, sizeof(bytes), &length)) return 1;
  struct stat directory_stat;
  int directory_fd = open_expected_directory(
    stage,
    expected_device,
    expected_inode,
    &directory_stat
  );
  if (directory_fd < 0) return 1;
  mode_t previous_umask = umask(0077);
  int file_fd = openat(
    directory_fd,
    name,
    O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW,
    0600
  );
  int open_error = errno;
  (void)umask(previous_umask);
  if (file_fd < 0) {
    (void)close(directory_fd);
    errno = open_error;
    return 1;
  }
  struct stat opened;
  struct stat at_path;
  bool identity_known = fstat(file_fd, &opened) == 0;
  bool valid = identity_known &&
    fchmod(file_fd, 0600) == 0 &&
    write_all_at(file_fd, (const char *)bytes, length) &&
    ftruncate(file_fd, (off_t)length) == 0 &&
    fsync(file_fd) == 0 &&
    fstat(file_fd, &opened) == 0 &&
    fstatat(directory_fd, name, &at_path, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISREG(opened.st_mode) &&
    S_ISREG(at_path.st_mode) &&
    opened.st_dev == at_path.st_dev &&
    opened.st_ino == at_path.st_ino &&
    opened.st_uid == geteuid() &&
    opened.st_nlink == 1 &&
    (opened.st_mode & 0777) == 0600 &&
    opened.st_size == (off_t)length &&
    read_exact_bytes(file_fd, bytes, length);
  int close_result = close(file_fd);
  if (!valid || close_result != 0) {
    if (identity_known) {
      (void)quarantine_remove_owned_file(
        directory_fd,
        name,
        &opened
      );
    }
    (void)close(directory_fd);
    return 1;
  }
  char device[32];
  char inode[32];
  identity_strings(&opened, device, sizeof(device), inode, sizeof(inode));
  (void)close(directory_fd);
  printf(
    "{\"ok\":true,\"dev\":\"%s\",\"ino\":\"%s\",\"mode\":%u,\"bytes\":%llu}\n",
    device,
    inode,
    (unsigned int)(opened.st_mode & 0777),
    (unsigned long long)length
  );
  return 0;
}

static int verify_stage_file(
  const char *directory,
  const char *expected_device,
  const char *expected_inode,
  const char *name,
  const char *content_base64
) {
  unsigned char bytes[2048];
  size_t length = 0;
  if (!decode_base64(content_base64, bytes, sizeof(bytes), &length)) return 1;
  struct stat directory_stat;
  int directory_fd = open_expected_directory(
    directory,
    expected_device,
    expected_inode,
    &directory_stat
  );
  if (directory_fd < 0) return 1;
  int file_fd = openat(directory_fd, name, O_RDONLY | O_NOFOLLOW);
  if (file_fd < 0) {
    (void)close(directory_fd);
    return 1;
  }
  struct stat opened;
  struct stat at_path;
  bool valid = fstat(file_fd, &opened) == 0 &&
    fstatat(directory_fd, name, &at_path, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISREG(opened.st_mode) &&
    S_ISREG(at_path.st_mode) &&
    opened.st_dev == at_path.st_dev &&
    opened.st_ino == at_path.st_ino &&
    opened.st_uid == geteuid() &&
    opened.st_nlink == 1 &&
    (opened.st_mode & 0777) == 0600 &&
    opened.st_size == (off_t)length &&
    read_exact_bytes(file_fd, bytes, length);
  int file_close = close(file_fd);
  int directory_close = close(directory_fd);
  if (!valid || file_close != 0 || directory_close != 0) return 1;
  fputs("{\"ok\":true}\n", stdout);
  return 0;
}

static int seal_directory(
  const char *directory,
  const char *expected_device,
  const char *expected_inode,
  int count
) {
  struct stat directory_stat;
  int directory_fd = open_expected_directory(
    directory,
    expected_device,
    expected_inode,
    &directory_stat
  );
  if (directory_fd < 0) return 1;
  bool valid = exact_directory_names(directory_fd, count) &&
    fsync(directory_fd) == 0;
  int close_result = close(directory_fd);
  if (!valid || close_result != 0) return 1;
  fputs("{\"ok\":true}\n", stdout);
  return 0;
}

static bool restore_quarantine(
  int parent_fd,
  const char *quarantine,
  const char *original
) {
  return renameatx_np(
    parent_fd,
    quarantine,
    parent_fd,
    original,
    RENAME_EXCL
  ) == 0;
}

static int remove_stage_file(
  const char *stage,
  const char *expected_device,
  const char *expected_inode,
  const char *name,
  const char *file_device,
  const char *file_inode,
  const char *content_base64
) {
  unsigned char bytes[2048];
  size_t length = 0;
  if (!decode_base64(content_base64, bytes, sizeof(bytes), &length)) return 1;
  struct stat directory_stat;
  int directory_fd = open_expected_directory(
    stage,
    expected_device,
    expected_inode,
    &directory_stat
  );
  if (directory_fd < 0) return 1;
  if (!exact_private_file(
        directory_fd,
        name,
        file_device,
        file_inode,
        bytes,
        length
      )) {
    (void)close(directory_fd);
    return 1;
  }
  char quarantine[96];
  int name_length = snprintf(
    quarantine,
    sizeof(quarantine),
    ".writcraft-cleanup-%s-%s",
    name,
    file_inode
  );
  if (name_length <= 0 || (size_t)name_length >= sizeof(quarantine) ||
      renameatx_np(
        directory_fd,
        name,
        directory_fd,
        quarantine,
        RENAME_EXCL
      ) != 0) {
    (void)close(directory_fd);
    return 1;
  }
  bool exact = exact_private_file(
    directory_fd,
    quarantine,
    file_device,
    file_inode,
    bytes,
    length
  );
  if (!exact) {
    (void)restore_quarantine(directory_fd, quarantine, name);
    (void)fsync(directory_fd);
    (void)close(directory_fd);
    return 1;
  }
  bool removed = unlinkat(directory_fd, quarantine, 0) == 0 &&
    fsync(directory_fd) == 0;
  int close_result = close(directory_fd);
  if (!removed || close_result != 0) return 1;
  fputs("{\"ok\":true}\n", stdout);
  return 0;
}

static int cleanup_empty_stage(
  const char *stage,
  const char *expected_device,
  const char *expected_inode
) {
  struct stat opened;
  int stage_fd = open_expected_directory(
    stage,
    expected_device,
    expected_inode,
    &opened
  );
  if (stage_fd < 0) return 1;
  bool empty = directory_is_empty(stage_fd);
  (void)close(stage_fd);
  if (!empty) return 1;
  char quarantine[128];
  int name_length = snprintf(
    quarantine,
    sizeof(quarantine),
    ".writcraft-structure-cleanup-%s",
    stage + sizeof(STAGE_PREFIX) - 1
  );
  if (name_length <= 0 || (size_t)name_length >= sizeof(quarantine) ||
      renameatx_np(
        PROJECT_ROOT_FD,
        stage,
        PROJECT_ROOT_FD,
        quarantine,
        RENAME_EXCL
      ) != 0) {
    return 1;
  }
  int quarantine_fd = openat(
    PROJECT_ROOT_FD,
    quarantine,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW
  );
  struct stat quarantined;
  struct stat at_path;
  bool exact = quarantine_fd >= 0 &&
    fstat(quarantine_fd, &quarantined) == 0 &&
    fstatat(
      PROJECT_ROOT_FD,
      quarantine,
      &at_path,
      AT_SYMLINK_NOFOLLOW
    ) == 0 &&
    quarantined.st_dev == opened.st_dev &&
    quarantined.st_ino == opened.st_ino &&
    at_path.st_dev == opened.st_dev &&
    at_path.st_ino == opened.st_ino &&
    directory_is_empty(quarantine_fd);
  if (quarantine_fd >= 0) (void)close(quarantine_fd);
  if (!exact) {
    (void)restore_quarantine(PROJECT_ROOT_FD, quarantine, stage);
    (void)fsync(PROJECT_ROOT_FD);
    return 1;
  }
  bool removed = unlinkat(PROJECT_ROOT_FD, quarantine, AT_REMOVEDIR) == 0 &&
    fsync(PROJECT_ROOT_FD) == 0;
  if (!removed) return 1;
  fputs("{\"ok\":true}\n", stdout);
  return 0;
}

static bool exact_control_identity(
  int directory_fd,
  const char *name,
  const char *expected_device,
  const char *expected_inode
) {
  int file_fd = openat(directory_fd, name, O_RDONLY | O_NOFOLLOW);
  if (file_fd < 0) return false;
  struct stat opened;
  struct stat at_path;
  char device[32];
  char inode[32];
  bool valid = fstat(file_fd, &opened) == 0 &&
    fstatat(directory_fd, name, &at_path, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISREG(opened.st_mode) &&
    S_ISREG(at_path.st_mode) &&
    opened.st_dev == at_path.st_dev &&
    opened.st_ino == at_path.st_ino &&
    opened.st_uid == geteuid() &&
    at_path.st_uid == geteuid() &&
    opened.st_nlink == 1 &&
    at_path.st_nlink == 1 &&
    (opened.st_mode & 0777) == 0600 &&
    (at_path.st_mode & 0777) == 0600;
  if (valid) {
    identity_strings(
      &opened,
      device,
      sizeof(device),
      inode,
      sizeof(inode)
    );
    valid = strcmp(device, expected_device) == 0 &&
      strcmp(inode, expected_inode) == 0;
  }
  int close_result = close(file_fd);
  return valid && close_result == 0;
}

static bool quarantine_and_remove_control(
  const char *name,
  const char *expected_device,
  const char *expected_inode,
  const char *suffix
) {
  if (!exact_control_identity(
        RECOVERY_FD,
        name,
        expected_device,
        expected_inode
      )) {
    return false;
  }
  char quarantine[128];
  int length = snprintf(
    quarantine,
    sizeof(quarantine),
    ".writcraft-control-cleanup-%s-%s",
    suffix,
    expected_inode
  );
  if (length <= 0 || (size_t)length >= sizeof(quarantine) ||
      renameatx_np(
        RECOVERY_FD,
        name,
        RECOVERY_FD,
        quarantine,
        RENAME_EXCL
      ) != 0) {
    return false;
  }
  if (!exact_control_identity(
        RECOVERY_FD,
        quarantine,
        expected_device,
        expected_inode
      )) {
    (void)restore_quarantine(RECOVERY_FD, quarantine, name);
    (void)fsync(RECOVERY_FD);
    return false;
  }
  return unlinkat(RECOVERY_FD, quarantine, 0) == 0;
}

static int cleanup_controls(
  const char *marker_device,
  const char *marker_inode,
  const char *receipt_device,
  const char *receipt_inode
) {
  if (!recovery_is_ready()) return 1;
  if (!quarantine_and_remove_control(
        "writing-structure-stage-receipt.json",
        receipt_device,
        receipt_inode,
        "receipt"
      )) {
    return 1;
  }
  if (!quarantine_and_remove_control(
        "writing-structure-transaction.json",
        marker_device,
        marker_inode,
        "marker"
      )) {
    (void)fsync(RECOVERY_FD);
    return 1;
  }
  if (fsync(RECOVERY_FD) != 0) return 1;
  fputs("{\"ok\":true}\n", stdout);
  return 0;
}

static int reserve_stage(const char *operation_id, const char *stage) {
  if (!trusted_root_is_ready() || !receipt_is_ready()) return 1;
  mode_t previous_umask = umask(0077);
  int mkdir_result = mkdirat(PROJECT_ROOT_FD, stage, 0700);
  int mkdir_error = errno;
  (void)umask(previous_umask);
  if (mkdir_result != 0) {
    errno = mkdir_error;
    return errno == EEXIST ? 2 : 1;
  }

  int stage_fd = openat(
    PROJECT_ROOT_FD,
    stage,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW
  );
  if (stage_fd < 0) return 1;
  struct stat opened;
  struct stat at_path;
  bool identity_known = false;
  bool valid = fstat(stage_fd, &opened) == 0 &&
    fstatat(
      PROJECT_ROOT_FD,
      stage,
      &at_path,
      AT_SYMLINK_NOFOLLOW
    ) == 0 &&
    exact_private_empty_stage(stage_fd, &opened, &at_path);
  if (valid) identity_known = true;
  if (valid) valid = fsync(PROJECT_ROOT_FD) == 0;
  if (valid) valid = write_receipt(operation_id, stage, &opened);
  int close_result = close(stage_fd);
  if (!valid) {
    if (identity_known) {
      remove_known_empty_stage_if_unchanged(stage, &opened);
    }
    return 1;
  }
  if (close_result != 0) return 1;

  char device[32];
  char inode[32];
  identity_strings(&opened, device, sizeof(device), inode, sizeof(inode));
  printf(
    "{\"ok\":true,\"operationId\":\"%s\",\"stage\":\"%s\","
    "\"dev\":\"%s\",\"ino\":\"%s\",\"mode\":%u}\n",
    operation_id,
    stage,
    device,
    inode,
    (unsigned int)(opened.st_mode & 0777)
  );
  return 0;
}

static int inspect_names(const char *stage, const char *target) {
  OptionalStat stage_stat;
  OptionalStat target_stat;
  if (!trusted_root_is_ready() ||
      !inspect_at(stage, &stage_stat) ||
      !inspect_at(target, &target_stat)) {
    return 1;
  }
  fputs("{\"ok\":true,\"stage\":", stdout);
  print_optional_identity(&stage_stat);
  fputs(",\"target\":", stdout);
  print_optional_identity(&target_stat);
  fputs("}\n", stdout);
  return 0;
}

static bool stage_matches_expected(
  const char *stage,
  const char *expected_device,
  const char *expected_inode
) {
  int stage_fd = openat(
    PROJECT_ROOT_FD,
    stage,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW
  );
  if (stage_fd < 0) return false;
  struct stat opened;
  struct stat at_path;
  char actual_device[32];
  char actual_inode[32];
  bool matches = fstat(stage_fd, &opened) == 0 &&
    fstatat(
      PROJECT_ROOT_FD,
      stage,
      &at_path,
      AT_SYMLINK_NOFOLLOW
    ) == 0 &&
    S_ISDIR(opened.st_mode) &&
    S_ISDIR(at_path.st_mode) &&
    opened.st_dev == at_path.st_dev &&
    opened.st_ino == at_path.st_ino &&
    (opened.st_mode & 0777) == 0700 &&
    opened.st_uid == geteuid();
  if (matches) {
    identity_strings(
      &opened,
      actual_device,
      sizeof(actual_device),
      actual_inode,
      sizeof(actual_inode)
    );
    matches = strcmp(actual_device, expected_device) == 0 &&
      strcmp(actual_inode, expected_inode) == 0;
  }
  int close_result = close(stage_fd);
  return matches && close_result == 0;
}

static int publish_stage(
  const char *stage,
  const char *target,
  const char *expected_device,
  const char *expected_inode
) {
  if (!trusted_root_is_ready()) {
    print_failure();
    return 1;
  }
  int code = EINVAL;
  if (stage_matches_expected(stage, expected_device, expected_inode)) {
    errno = 0;
    int rename_result = renameatx_np(
      PROJECT_ROOT_FD,
      stage,
      PROJECT_ROOT_FD,
      target,
      RENAME_EXCL
    );
    code = rename_result == 0 ? 0 : errno;
    if (rename_result == 0 && fsync(PROJECT_ROOT_FD) != 0) code = errno;
  }
  OptionalStat stage_stat;
  OptionalStat target_stat;
  if (!inspect_at(stage, &stage_stat) ||
      !inspect_at(target, &target_stat)) {
    return 1;
  }
  bool expected = false;
  if (!stage_stat.exists &&
      target_stat.exists &&
      S_ISDIR(target_stat.value.st_mode)) {
    char actual_device[32];
    char actual_inode[32];
    identity_strings(
      &target_stat.value,
      actual_device,
      sizeof(actual_device),
      actual_inode,
      sizeof(actual_inode)
    );
    expected = strcmp(actual_device, expected_device) == 0 &&
      strcmp(actual_inode, expected_inode) == 0;
  }
  printf(
    "{\"ok\":%s,\"errno\":%d,\"stage\":",
    code == 0 && expected ? "true" : "false",
    code
  );
  print_optional_identity(&stage_stat);
  fputs(",\"target\":", stdout);
  print_optional_identity(&target_stat);
  printf(",\"expected\":%s}\n", expected ? "true" : "false");
  if (code == 0 && expected) return 0;
  return code == EEXIST ? 2 : 1;
}

int main(void) {
  char request[INPUT_CAPACITY];
  size_t length = 0;
  if (!read_request(request, sizeof(request), &length)) {
    print_failure();
    return 1;
  }

  char operation_id[64] = {0};
  char stage[128] = {0};
  if (parse_reserve(request, length, operation_id, stage)) {
    int status = reserve_stage(operation_id, stage);
    if (status != 0) print_failure();
    return status;
  }

  char expected_device[32] = {0};
  char expected_inode[32] = {0};
  char name[16] = {0};
  char content_base64[2048] = {0};
  char directory[128] = {0};
  if (parse_file_request(
        request,
        length,
        "write",
        directory,
        expected_device,
        expected_inode,
        name,
        content_base64
      )) {
    int status = write_stage_file(
      directory,
      expected_device,
      expected_inode,
      name,
      content_base64
    );
    if (status != 0) print_failure();
    return status;
  }
  memset(directory, 0, sizeof(directory));
  memset(expected_device, 0, sizeof(expected_device));
  memset(expected_inode, 0, sizeof(expected_inode));
  memset(name, 0, sizeof(name));
  memset(content_base64, 0, sizeof(content_base64));
  if (parse_file_request(
        request,
        length,
        "verify",
        directory,
        expected_device,
        expected_inode,
        name,
        content_base64
      )) {
    int status = verify_stage_file(
      directory,
      expected_device,
      expected_inode,
      name,
      content_base64
    );
    if (status != 0) print_failure();
    return status;
  }
  int count = 0;
  memset(directory, 0, sizeof(directory));
  memset(expected_device, 0, sizeof(expected_device));
  memset(expected_inode, 0, sizeof(expected_inode));
  if (parse_seal(
        request,
        length,
        directory,
        expected_device,
        expected_inode,
        &count
      )) {
    int status = seal_directory(
      directory,
      expected_device,
      expected_inode,
      count
    );
    if (status != 0) print_failure();
    return status;
  }
  char file_device[32] = {0};
  char file_inode[32] = {0};
  memset(stage, 0, sizeof(stage));
  memset(expected_device, 0, sizeof(expected_device));
  memset(expected_inode, 0, sizeof(expected_inode));
  memset(name, 0, sizeof(name));
  memset(content_base64, 0, sizeof(content_base64));
  if (parse_remove_file(
        request,
        length,
        stage,
        expected_device,
        expected_inode,
        name,
        file_device,
        file_inode,
        content_base64
      )) {
    int status = remove_stage_file(
      stage,
      expected_device,
      expected_inode,
      name,
      file_device,
      file_inode,
      content_base64
    );
    if (status != 0) print_failure();
    return status;
  }
  memset(stage, 0, sizeof(stage));
  memset(expected_device, 0, sizeof(expected_device));
  memset(expected_inode, 0, sizeof(expected_inode));
  if (parse_cleanup_stage(
        request,
        length,
        stage,
        expected_device,
        expected_inode
      )) {
    int status = cleanup_empty_stage(
      stage,
      expected_device,
      expected_inode
    );
    if (status != 0) print_failure();
    return status;
  }
  char marker_device[32] = {0};
  char marker_inode[32] = {0};
  char receipt_device[32] = {0};
  char receipt_inode[32] = {0};
  if (parse_cleanup_controls(
        request,
        length,
        marker_device,
        marker_inode,
        receipt_device,
        receipt_inode
      )) {
    int status = cleanup_controls(
      marker_device,
      marker_inode,
      receipt_device,
      receipt_inode
    );
    if (status != 0) print_failure();
    return status;
  }

  char target[32] = {0};
  if (parse_inspect(request, length, stage, target)) {
    int status = inspect_names(stage, target);
    if (status != 0) print_failure();
    return status;
  }

  memset(expected_device, 0, sizeof(expected_device));
  memset(expected_inode, 0, sizeof(expected_inode));
  if (parse_publish(
        request,
        length,
        stage,
        target,
        expected_device,
        expected_inode
      )) {
    int status = publish_stage(
      stage,
      target,
      expected_device,
      expected_inode
    );
    return status;
  }

  print_failure();
  return 1;
}
