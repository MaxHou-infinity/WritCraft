#define _DARWIN_C_SOURCE

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

#define SOURCE_PARENT_FD 3
#define TARGET_PARENT_FD 4
#define RESERVATION_RECEIPT_FD 5
#define INPUT_CAPACITY 4096
#define STAGE_PREFIX ".writcraft-author-copy-"

typedef struct {
  bool exists;
  struct stat value;
} OptionalStat;

static void print_failure(void) {
  fputs("{\"ok\":false,\"errno\":null}\n", stdout);
}

static bool digits_only(const char *value) {
  if (value[0] == '\0') return false;
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor; cursor += 1) {
    if (*cursor < '0' || *cursor > '9') return false;
  }
  return true;
}

static bool safe_name(const char *value) {
  return value[0] != '\0' &&
    strchr(value, '/') == NULL &&
    strchr(value, '\\') == NULL;
}

static bool read_request(char *buffer, size_t capacity, size_t *length_out) {
  size_t length = fread(buffer, 1, capacity - 1, stdin);
  if (ferror(stdin) || (!feof(stdin) && length == capacity - 1)) return false;
  if (memchr(buffer, '\0', length) != NULL) return false;
  buffer[length] = '\0';
  *length_out = length;
  return true;
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

// The parent creates this unlinked 0600 regular-file descriptor before the
// helper starts. stdout is only a convenience receipt: if it is lost after a
// successful reservation, this fd still binds the exact stage identity.
static bool reservation_receipt_is_ready(void) {
  struct stat receipt;
  int flags = fcntl(RESERVATION_RECEIPT_FD, F_GETFL);
  if (flags < 0 || (flags & O_ACCMODE) != O_RDWR ||
      fstat(RESERVATION_RECEIPT_FD, &receipt) != 0 ||
      !S_ISREG(receipt.st_mode) ||
      (receipt.st_mode & 0777) != 0600) {
    return false;
  }
  return true;
}

static bool write_reservation_receipt(const char *name, const struct stat *value) {
  if (!reservation_receipt_is_ready()) return false;
  char device[32];
  char inode[32];
  char payload[256];
  identity_strings(value, device, sizeof(device), inode, sizeof(inode));
  int length = snprintf(
    payload,
    sizeof(payload),
    "{\"ok\":true,\"name\":\"%s\",\"dev\":\"%s\",\"ino\":\"%s\",\"mode\":%u}\n",
    name,
    device,
    inode,
    (unsigned int)(value->st_mode & 0777)
  );
  if (length <= 0 || (size_t)length >= sizeof(payload) ||
      ftruncate(RESERVATION_RECEIPT_FD, 0) != 0) {
    return false;
  }
  size_t offset = 0;
  while (offset < (size_t)length) {
    ssize_t written = pwrite(
      RESERVATION_RECEIPT_FD,
      payload + offset,
      (size_t)length - offset,
      (off_t)offset
    );
    if (written <= 0) return false;
    offset += (size_t)written;
  }
  return fsync(RESERVATION_RECEIPT_FD) == 0;
}

// This is only used after an fd has established the exact directory identity.
// A replacement observed by fstatat is never removed. The mkdirat->openat
// interval remains the separately documented residual P2.
static void remove_known_reservation_if_unchanged(
  const char *name,
  const struct stat *opened
) {
  struct stat current;
  if (fstatat(SOURCE_PARENT_FD, name, &current, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(current.st_mode) ||
      current.st_dev != opened->st_dev || current.st_ino != opened->st_ino) {
    return;
  }
  if (unlinkat(SOURCE_PARENT_FD, name, AT_REMOVEDIR) == 0) {
    (void)fsync(SOURCE_PARENT_FD);
  }
}

static bool inspect_at(int parent_fd, const char *name, OptionalStat *result) {
  memset(result, 0, sizeof(*result));
  if (fstatat(parent_fd, name, &result->value, AT_SYMLINK_NOFOLLOW) == 0) {
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
  identity_strings(&value->value, device, sizeof(device), inode, sizeof(inode));
  printf(
    "{\"type\":\"%s\",\"dev\":\"%s\",\"ino\":\"%s\",\"mode\":%u}",
    S_ISDIR(value->value.st_mode) ? "directory" : "other",
    device,
    inode,
    (unsigned int)(value->value.st_mode & 0777)
  );
}

static int reserve_directory(void) {
  // Do this before mkdirat. A reserve without a Main-owned recovery receipt
  // must not create a stage whose committed identity cannot be recovered.
  if (!reservation_receipt_is_ready()) return 1;
  for (int attempt = 0; attempt < 16; attempt += 1) {
    unsigned char random_bytes[24];
    char name[sizeof(STAGE_PREFIX) + (sizeof(random_bytes) * 2)];
    arc4random_buf(random_bytes, sizeof(random_bytes));
    memcpy(name, STAGE_PREFIX, sizeof(STAGE_PREFIX) - 1);
    for (size_t index = 0; index < sizeof(random_bytes); index += 1) {
      snprintf(
        name + sizeof(STAGE_PREFIX) - 1 + (index * 2),
        3,
        "%02x",
        random_bytes[index]
      );
    }
    name[sizeof(name) - 1] = '\0';
    if (mkdirat(SOURCE_PARENT_FD, name, 0700) != 0) {
      if (errno == EEXIST) continue;
      return 1;
    }
    int directory_fd = openat(
      SOURCE_PARENT_FD,
      name,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW
    );
    if (directory_fd < 0) return 1;
    bool valid = fchmod(directory_fd, 0700) == 0;
    struct stat opened;
    struct stat at_path;
    if (valid) valid = fstat(directory_fd, &opened) == 0;
    if (valid) {
      valid = fstatat(
        SOURCE_PARENT_FD,
        name,
        &at_path,
        AT_SYMLINK_NOFOLLOW
      ) == 0;
    }
    bool identity_known = false;
    if (valid) {
      valid = S_ISDIR(opened.st_mode) &&
        opened.st_dev == at_path.st_dev &&
        opened.st_ino == at_path.st_ino;
    }
    if (valid) identity_known = true;
    if (valid) valid = fsync(SOURCE_PARENT_FD) == 0;
    if (valid) valid = write_reservation_receipt(name, &opened);
    int close_result = close(directory_fd);
    if (!valid) {
      if (identity_known) remove_known_reservation_if_unchanged(name, &opened);
      return 1;
    }
    if (close_result != 0) return 1;
    char device[32];
    char inode[32];
    identity_strings(&opened, device, sizeof(device), inode, sizeof(inode));
    printf(
      "{\"ok\":true,\"name\":\"%s\",\"dev\":\"%s\",\"ino\":\"%s\",\"mode\":%u}\n",
      name,
      device,
      inode,
      (unsigned int)(opened.st_mode & 0777)
    );
    return 0;
  }
  return 1;
}

static bool parse_inspect(
  const char *request,
  size_t length,
  char *source,
  char *target
) {
  int consumed = 0;
  int matched = sscanf(
    request,
    "{\"mode\":\"inspect\",\"source\":\"%127[^\"]\",\"target\":\"%1023[^\"]\"}%n",
    source,
    target,
    &consumed
  );
  return matched == 2 &&
    consumed == (int)length &&
    strncmp(source, STAGE_PREFIX, sizeof(STAGE_PREFIX) - 1) == 0 &&
    safe_name(source) &&
    safe_name(target);
}

static bool parse_publish(
  const char *request,
  size_t length,
  char *source,
  char *target,
  char *expected_device,
  char *expected_inode
) {
  int consumed = 0;
  int matched = sscanf(
    request,
    "{\"mode\":\"publish\",\"source\":\"%127[^\"]\",\"target\":\"%1023[^\"]\","
    "\"dev\":\"%31[0-9]\",\"ino\":\"%31[0-9]\"}%n",
    source,
    target,
    expected_device,
    expected_inode,
    &consumed
  );
  return matched == 4 &&
    consumed == (int)length &&
    strncmp(source, STAGE_PREFIX, sizeof(STAGE_PREFIX) - 1) == 0 &&
    safe_name(source) &&
    safe_name(target) &&
    digits_only(expected_device) &&
    digits_only(expected_inode);
}

static int inspect_names(const char *source, const char *target) {
  OptionalStat source_stat;
  OptionalStat target_stat;
  if (!inspect_at(SOURCE_PARENT_FD, source, &source_stat) ||
      !inspect_at(TARGET_PARENT_FD, target, &target_stat)) {
    return 1;
  }
  fputs("{\"ok\":true,\"source\":", stdout);
  print_optional_identity(&source_stat);
  fputs(",\"target\":", stdout);
  print_optional_identity(&target_stat);
  fputs("}\n", stdout);
  return 0;
}

static int publish_directory(
  const char *source,
  const char *target,
  const char *expected_device,
  const char *expected_inode
) {
  errno = 0;
  int result = renameatx_np(
    SOURCE_PARENT_FD,
    source,
    TARGET_PARENT_FD,
    target,
    RENAME_EXCL
  );
  int code = result == 0 ? 0 : errno;
  OptionalStat source_stat;
  OptionalStat target_stat;
  if (!inspect_at(SOURCE_PARENT_FD, source, &source_stat) ||
      !inspect_at(TARGET_PARENT_FD, target, &target_stat)) {
    return 1;
  }
  bool expected = false;
  if (!source_stat.exists && target_stat.exists && S_ISDIR(target_stat.value.st_mode)) {
    char actual_device[32];
    char actual_inode[32];
    identity_strings(
      &target_stat.value,
      actual_device,
      sizeof(actual_device),
      actual_inode,
      sizeof(actual_inode)
    );
    expected = strcmp(expected_device, actual_device) == 0 &&
      strcmp(expected_inode, actual_inode) == 0;
  }
  printf(
    "{\"ok\":%s,\"errno\":%d,\"source\":",
    code == 0 ? "true" : "false",
    code
  );
  print_optional_identity(&source_stat);
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
  if (strcmp(request, "{\"mode\":\"reserve\"}") == 0) {
    int status = reserve_directory();
    if (status != 0) print_failure();
    return status;
  }
  char source[128] = {0};
  char target[1024] = {0};
  if (parse_inspect(request, length, source, target)) {
    int status = inspect_names(source, target);
    if (status != 0) print_failure();
    return status;
  }
  char expected_device[32] = {0};
  char expected_inode[32] = {0};
  if (parse_publish(
    request,
    length,
    source,
    target,
    expected_device,
    expected_inode
  )) {
    int status = publish_directory(
      source,
      target,
      expected_device,
      expected_inode
    );
    if (status == 1 && ferror(stdout)) return 1;
    return status;
  }
  print_failure();
  return 1;
}
