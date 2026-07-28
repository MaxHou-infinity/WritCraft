#define _DARWIN_C_SOURCE

#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifdef WRITCRAFT_TEST_RESERVE_PREOWNERSHIP
#include <sys/wait.h>
#endif

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
    if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) {
      empty = false;
      break;
    }
  }
  int scan_error = errno;
  int close_result = closedir(directory);
  return empty && scan_error == 0 && close_result == 0;
}

static bool is_exact_private_reservation(
  int directory_fd,
  const struct stat *opened,
  const struct stat *at_path
) {
  if (!S_ISDIR(opened->st_mode) || !S_ISDIR(at_path->st_mode) ||
      opened->st_dev != at_path->st_dev || opened->st_ino != at_path->st_ino ||
      (opened->st_mode & 0777) != 0700 ||
      (at_path->st_mode & 0777) != 0700 ||
      opened->st_uid != geteuid() || at_path->st_uid != geteuid() ||
      opened->st_gid != at_path->st_gid) {
    return false;
  }
  return directory_is_empty(directory_fd);
}

#ifdef WRITCRAFT_TEST_RESERVE_PREOWNERSHIP
// The test build replaces the just-created directory before the parent opens
// it. This deliberately lives behind a compile-time flag so release helpers
// have neither this code path nor its test-only marker.
static bool replace_reservation_before_open_for_test(const char *name) {
  unsigned char random_bytes[12];
  char original_name[sizeof(".original-") + (sizeof(random_bytes) * 2)];
  arc4random_buf(random_bytes, sizeof(random_bytes));
  memcpy(original_name, ".original-", sizeof(".original-") - 1);
  for (size_t index = 0; index < sizeof(random_bytes); index += 1) {
    snprintf(
      original_name + sizeof(".original-") - 1 + (index * 2),
      3,
      "%02x",
      random_bytes[index]
    );
  }
  original_name[sizeof(original_name) - 1] = '\0';
  pid_t child = fork();
  if (child < 0) return false;
  if (child == 0) {
    if (renameatx_np(
          SOURCE_PARENT_FD,
          name,
          SOURCE_PARENT_FD,
          original_name,
          RENAME_EXCL
        ) != 0 ||
        mkdirat(SOURCE_PARENT_FD, name, 0755) != 0) {
      _exit(1);
    }
    _exit(0);
  }
  int status = 0;
  return waitpid(child, &status, 0) == child &&
    WIFEXITED(status) && WEXITSTATUS(status) == 0;
}
#endif

// This is only used after an fd has established the exact directory identity.
// A replacement observed by fstatat is never removed. A same-UID, 0700, empty
// directory can still be indistinguishable in the mkdirat->openat interval;
// that pre-ownership case remains the separately documented residual P2.
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
    mode_t previous_umask = umask(0077);
    int mkdir_result = mkdirat(SOURCE_PARENT_FD, name, 0700);
    int mkdir_error = errno;
    (void)umask(previous_umask);
    if (mkdir_result != 0) {
      errno = mkdir_error;
      if (errno == EEXIST) continue;
      return 1;
    }
#ifdef WRITCRAFT_TEST_RESERVE_PREOWNERSHIP
    if (!replace_reservation_before_open_for_test(name)) return 1;
#endif
    int directory_fd = openat(
      SOURCE_PARENT_FD,
      name,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW
    );
    if (directory_fd < 0) return 1;
    bool valid = true;
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
      valid = is_exact_private_reservation(directory_fd, &opened, &at_path);
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
