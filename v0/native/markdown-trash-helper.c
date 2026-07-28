#define _DARWIN_C_SOURCE

#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
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
#define MAX_LINE_BYTES (3 * 1024 * 1024)
#define MAX_MANIFEST_BYTES (1024 * 1024)
#define MAX_COMPONENTS 128
#define CHUNK_BYTES 1024
#define JOURNAL_PREFIX ".writcraft-md-restore-"
#define ABSENT_MANIFEST_DIGEST "0000000000000000000000000000000000000000000000000000000000000000"

typedef struct {
  dev_t dev;
  ino_t ino;
  off_t size;
} FileIdentity;

typedef struct {
  dev_t dev;
  ino_t ino;
  off_t size;
  mode_t mode;
} BoundIdentity;

typedef struct {
  char state;
  char operation;
  char source_hex[1024];
  char target_hex[8192];
  char digest[65];
  char m0[65];
  char m1[65];
  char qsource[96];
  char qmanifest[96];
  char newmanifest[96];
  FileIdentity identity;
  BoundIdentity source_parent;
  BoundIdentity target_parent;
  FileIdentity m0_identity;
  FileIdentity m1_identity;
  FileIdentity self_identity;
} Journal;

static bool bound_from_fd(int fd, BoundIdentity *out) {
  struct stat value;
  if (fstat(fd, &value) != 0 || !S_ISDIR(value.st_mode)) return false;
  out->dev = value.st_dev; out->ino = value.st_ino; out->size = value.st_size; out->mode = value.st_mode;
  return true;
}

static bool same_bound_directory(int fd, const BoundIdentity *expected) {
  BoundIdentity current;
  return bound_from_fd(fd, &current) && current.dev == expected->dev && current.ino == expected->ino && current.mode == expected->mode;
}

static bool file_identity_from_stat(const struct stat *stat, FileIdentity *out) {
  if (!S_ISREG(stat->st_mode) || stat->st_size < 0) return false;
  out->dev = stat->st_dev; out->ino = stat->st_ino; out->size = stat->st_size; return true;
}

static bool stat_matches_file_identity(const struct stat *stat, const FileIdentity *expected) {
  FileIdentity actual;
  return file_identity_from_stat(stat, &actual) && actual.dev == expected->dev && actual.ino == expected->ino && actual.size == expected->size;
}

static bool journal_receipt_matches(const struct stat *stat, const Journal *journal) {
  return S_ISREG(stat->st_mode) && stat->st_dev == journal->self_identity.dev &&
    stat->st_ino == journal->self_identity.ino && stat->st_size == journal->self_identity.size &&
    (stat->st_mode & 0777) == 0600;
}

static void response(const char *kind, unsigned long long sequence, const char *status) {
  if (strcmp(kind, "R") == 0 || strcmp(kind, "T") == 0) {
    const char *reason = strcmp(status, "COMMITTED") == 0 ? "NONE" :
      strcmp(status, "RECOVERY_REQUIRED") == 0 ? "UNKNOWN" : "REQUEST_INVALID";
    printf("%s\t%llu\t%s\t%s\n", kind, sequence, status, reason);
  } else {
    printf("%s\t%llu\t%s\n", kind, sequence, status);
  }
  fflush(stdout);
}

static void operation_response(const char *kind, unsigned long long sequence, const char *state, const char *reason) {
  printf("%s\t%llu\t%s\t%s\n", kind, sequence, state, reason);
  fflush(stdout);
}

static bool safe_component(const char *value) {
  return value && value[0] && strcmp(value, ".") != 0 && strcmp(value, "..") != 0 &&
    strchr(value, '/') == NULL && strchr(value, '\\') == NULL;
}

static bool hex_decode(const char *input, unsigned char *output, size_t output_capacity, size_t *length) {
  size_t source_length = strlen(input);
  if ((source_length & 1) || source_length / 2 > output_capacity) return false;
  for (size_t index = 0; index < source_length; index += 2) {
    unsigned int byte = 0;
    if (sscanf(input + index, "%2x", &byte) != 1) return false;
    output[index / 2] = (unsigned char)byte;
  }
  *length = source_length / 2;
  return true;
}

static bool hex_string(const char *value, size_t expected) {
  if (strlen(value) != expected) return false;
  for (size_t index = 0; index < expected; index += 1) {
    if (!(value[index] >= '0' && value[index] <= '9') &&
        !(value[index] >= 'a' && value[index] <= 'f')) return false;
  }
  return true;
}

static void digest_hex(const unsigned char *data, size_t length, char output[65]) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data, (CC_LONG)length, digest);
  for (size_t index = 0; index < sizeof(digest); index += 1) {
    snprintf(output + (index * 2), 3, "%02x", digest[index]);
  }
  output[64] = '\0';
}

static bool full_write(int fd, const void *value, size_t length) {
  const unsigned char *cursor = value;
  while (length > 0) {
    ssize_t written = write(fd, cursor, length);
    if (written <= 0) return false;
    cursor += written;
    length -= (size_t)written;
  }
  return true;
}

static bool read_regular_at(
  int parent_fd,
  const char *name,
  unsigned char **bytes_out,
  size_t *length_out,
  struct stat *stat_out,
  char digest_out[65]
) {
  int fd = openat(parent_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat before;
  bool valid = fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_size >= 0 &&
    before.st_size <= MAX_MANIFEST_BYTES && before.st_nlink == 1;
  unsigned char *bytes = NULL;
  if (valid) {
    bytes = malloc((size_t)before.st_size + 1);
    valid = bytes != NULL;
  }
  size_t offset = 0;
  while (valid && offset < (size_t)before.st_size) {
    ssize_t got = read(fd, bytes + offset, (size_t)before.st_size - offset);
    if (got <= 0) valid = false;
    else offset += (size_t)got;
  }
  struct stat after;
  if (valid) valid = fstat(fd, &after) == 0 && after.st_dev == before.st_dev &&
    after.st_ino == before.st_ino && after.st_size == before.st_size &&
    after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec &&
    after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec &&
    after.st_ctimespec.tv_sec == before.st_ctimespec.tv_sec &&
    after.st_ctimespec.tv_nsec == before.st_ctimespec.tv_nsec;
  if (close(fd) != 0) valid = false;
  if (!valid) {
    free(bytes);
    return false;
  }
  bytes[before.st_size] = '\0';
  digest_hex(bytes, (size_t)before.st_size, digest_out);
  *bytes_out = bytes;
  *length_out = (size_t)before.st_size;
  *stat_out = before;
  return true;
}

static bool read_source_at(
  int parent_fd,
  const char *name,
  const FileIdentity *expected,
  const char *expected_digest,
  struct stat *out
) {
  int fd = openat(parent_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat before;
  bool valid = fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_size >= 0 &&
    before.st_dev == expected->dev && before.st_ino == expected->ino && before.st_size == expected->size &&
    before.st_size <= 16 * 1024 * 1024 && before.st_nlink == 1;
  CC_SHA256_CTX context;
  if (valid) CC_SHA256_Init(&context);
  unsigned char buffer[8192];
  while (valid) {
    ssize_t got = read(fd, buffer, sizeof(buffer));
    if (got < 0) valid = false;
    else if (got == 0) break;
    else CC_SHA256_Update(&context, buffer, (CC_LONG)got);
  }
  char actual_digest[65] = {0};
  if (valid) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &context);
    for (size_t index = 0; index < sizeof(digest); index += 1) {
      snprintf(actual_digest + (index * 2), 3, "%02x", digest[index]);
    }
  }
  struct stat after;
  if (valid) valid = fstat(fd, &after) == 0 && after.st_dev == before.st_dev &&
    after.st_ino == before.st_ino && after.st_size == before.st_size &&
    after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec &&
    after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec &&
    strcmp(actual_digest, expected_digest) == 0;
  if (close(fd) != 0) valid = false;
  if (valid) *out = before;
  return valid;
}

static bool inspect_source_at(int parent_fd, const char *name, off_t maximum, struct stat *out, char digest_out[65]) {
  int fd = openat(parent_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat before;
  bool valid = fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_nlink == 1 &&
    before.st_size >= 0 && before.st_size <= maximum;
  CC_SHA256_CTX context;
  if (valid) CC_SHA256_Init(&context);
  unsigned char buffer[8192];
  while (valid) {
    ssize_t got = read(fd, buffer, sizeof(buffer));
    if (got < 0) valid = false;
    else if (got == 0) break;
    else CC_SHA256_Update(&context, buffer, (CC_LONG)got);
  }
#ifdef WRITCRAFT_TEST_INSPECT_DRIFT
  if (valid) {
    int drift = openat(parent_fd, name, O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
    if (drift >= 0) { (void)ftruncate(drift, 0); (void)write(drift, "drift", 5); (void)fsync(drift); (void)close(drift); }
  }
#endif
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (valid) CC_SHA256_Final(digest, &context);
  struct stat after;
  if (valid) valid = fstat(fd, &after) == 0 && after.st_dev == before.st_dev && after.st_ino == before.st_ino &&
    after.st_size == before.st_size && after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec &&
    after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec && after.st_ctimespec.tv_sec == before.st_ctimespec.tv_sec &&
    after.st_ctimespec.tv_nsec == before.st_ctimespec.tv_nsec;
  if (close(fd) != 0) valid = false;
  if (!valid) return false;
  for (size_t index = 0; index < sizeof(digest); index += 1) snprintf(digest_out + (index * 2), 3, "%02x", digest[index]);
  digest_out[64] = '\0'; *out = before; return true;
}

static int open_relative_parent(int root_fd, const char *relative, char leaf[256]) {
  if (!relative || !relative[0] || strlen(relative) > 4096) return -1;
  char copy[4097];
  strcpy(copy, relative);
  int current = dup(root_fd);
  if (current < 0) return -1;
  char *save = NULL;
  char *part = strtok_r(copy, "/", &save);
  size_t count = 0;
  while (part) {
    if (!safe_component(part) || ++count > MAX_COMPONENTS) { close(current); return -1; }
    char *next = strtok_r(NULL, "/", &save);
    if (!next) {
      if (strlen(part) >= 256) { close(current); return -1; }
      strcpy(leaf, part);
      return current;
    }
    int next_fd = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(current);
    if (next_fd < 0) return -1;
    current = next_fd;
    part = next;
  }
  close(current);
  return -1;
}

static int open_trash(int root_fd) {
  int meta = openat(root_fd, ".writcraft", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (meta < 0) return -1;
  struct stat opened_meta, current_meta;
  bool meta_valid = fstat(meta, &opened_meta) == 0 &&
    fstatat(root_fd, ".writcraft", &current_meta, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISDIR(opened_meta.st_mode) && S_ISDIR(current_meta.st_mode) &&
    opened_meta.st_dev == current_meta.st_dev && opened_meta.st_ino == current_meta.st_ino &&
    (opened_meta.st_mode & 0777) == 0700 && (current_meta.st_mode & 0777) == 0700 &&
    opened_meta.st_uid == geteuid() && current_meta.st_uid == geteuid();
  if (!meta_valid) {
    close(meta);
    errno = EPERM;
    return -1;
  }
  int trash = openat(meta, "trash", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (trash >= 0) {
    struct stat opened, current;
    bool valid = fstat(trash, &opened) == 0 && fstatat(meta, "trash", &current, AT_SYMLINK_NOFOLLOW) == 0 &&
      S_ISDIR(opened.st_mode) && S_ISDIR(current.st_mode) && opened.st_dev == current.st_dev && opened.st_ino == current.st_ino &&
      (opened.st_mode & 0777) == 0700 && (current.st_mode & 0777) == 0700 &&
      opened.st_uid == geteuid() && current.st_uid == geteuid();
    if (!valid) { close(trash); trash = -1; errno = EPERM; }
  }
  close(meta);
  return trash;
}

// Bootstrap is fd-relative.  A just-created directory must be private and
// owned by this process; an existing directory is only accepted through an
// already-bound parent descriptor and is never chmod'ed in place.
static int open_or_create_private_dir(int parent_fd, const char *name) {
  int fd = openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd >= 0) {
    struct stat opened, current;
    bool valid = fstat(fd, &opened) == 0 && fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
      S_ISDIR(opened.st_mode) && S_ISDIR(current.st_mode) && opened.st_dev == current.st_dev && opened.st_ino == current.st_ino &&
      (opened.st_mode & 0777) == 0700 && (current.st_mode & 0777) == 0700 &&
      opened.st_uid == geteuid() && current.st_uid == geteuid();
    if (valid) return fd;
    close(fd); errno = EPERM; return -1;
  }
  if (errno != ENOENT) return -1;
  mode_t previous_umask = umask(0077);
  int created = mkdirat(parent_fd, name, 0700);
  int created_error = errno;
  (void)umask(previous_umask);
  if (created != 0) { errno = created_error; return -1; }
  fd = openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat opened, current;
  bool valid = fd >= 0 && fstat(fd, &opened) == 0 &&
    fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISDIR(opened.st_mode) && S_ISDIR(current.st_mode) &&
    opened.st_dev == current.st_dev && opened.st_ino == current.st_ino &&
    (opened.st_mode & 0777) == 0700 && (current.st_mode & 0777) == 0700 &&
    opened.st_uid == geteuid() && current.st_uid == geteuid() &&
    opened.st_gid == getegid() && current.st_gid == getegid() && fsync(parent_fd) == 0;
  if (!valid) { if (fd >= 0) close(fd); return -1; }
  return fd;
}

static int open_or_create_trash(int root_fd) {
  int meta = open_or_create_private_dir(root_fd, ".writcraft");
  if (meta < 0) return -1;
  int trash = open_or_create_private_dir(meta, "trash");
  close(meta);
  return trash;
}

static bool absent_at(int parent_fd, const char *name) {
  struct stat value;
  return fstatat(parent_fd, name, &value, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
}

static bool manifest_matches(int trash_fd, const char *expected) {
  if (strcmp(expected, ABSENT_MANIFEST_DIGEST) == 0) return absent_at(trash_fd, "manifest.json");
  unsigned char *bytes = NULL; size_t length = 0; struct stat stat; char digest[65];
  bool ok = read_regular_at(trash_fd, "manifest.json", &bytes, &length, &stat, digest) && strcmp(digest, expected) == 0;
  free(bytes); return ok;
}

static bool write_private_manifest(int trash_fd, const char *name, const unsigned char *bytes, size_t length, const char *digest) {
  int fd = openat(trash_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  bool ok = fd >= 0 && full_write(fd, bytes, length) && fsync(fd) == 0;
  if (fd >= 0 && close(fd) != 0) ok = false;
  if (!ok || fsync(trash_fd) != 0) return false;
  unsigned char *verify = NULL; size_t verify_length = 0; struct stat stat; char actual[65];
  ok = read_regular_at(trash_fd, name, &verify, &verify_length, &stat, actual) && verify_length == length && strcmp(actual, digest) == 0;
  free(verify); return ok;
}

static bool same_identity(const struct stat *stat, const FileIdentity *expected) {
  return stat->st_dev == expected->dev && stat->st_ino == expected->ino && stat->st_size == expected->size;
}

static bool same_directory_fd(int first, int second) {
  struct stat a, b;
  return fstat(first, &a) == 0 && fstat(second, &b) == 0 && S_ISDIR(a.st_mode) && S_ISDIR(b.st_mode) &&
    a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode;
}

static bool revalidate_relative_parent(int root_fd, const char *relative, int opened_parent) {
  char leaf[256]; int fresh = open_relative_parent(root_fd, relative, leaf);
  bool valid = fresh >= 0 && same_directory_fd(fresh, opened_parent);
  if (fresh >= 0) close(fresh); return valid;
}

static bool revalidate_trash_parent(int root_fd, int opened_trash) {
  int fresh = open_trash(root_fd); bool valid = fresh >= 0 && same_directory_fd(fresh, opened_trash);
  if (fresh >= 0) close(fresh); return valid;
}

static bool random_name(const char *prefix, char output[96]) {
  unsigned char bytes[16];
  arc4random_buf(bytes, sizeof(bytes));
  int used = snprintf(output, 96, "%s", prefix);
  if (used < 0 || used >= 96) return false;
  for (size_t index = 0; index < sizeof(bytes); index += 1) {
    if ((size_t)used + 2 >= 96) return false;
    snprintf(output + used + (index * 2), 3, "%02x", bytes[index]);
  }
  return true;
}

static int format_journal_body(char *body, size_t capacity, const Journal *journal, off_t self_size) {
  return snprintf(body, capacity,
    "%c\t%c\t%s\t%s\t%s\t%llu\t%llu\t%lld\t%s\t%s\t%s\t%s\t%s\t%llu\t%llu\t%lld\t%u\t%llu\t%llu\t%lld\t%u\t%llu\t%llu\t%lld\t%llu\t%llu\t%lld\t%llu\t%llu\t%lld",
    journal->state, journal->operation, journal->source_hex, journal->target_hex, journal->digest,
    (unsigned long long)journal->identity.dev, (unsigned long long)journal->identity.ino,
    (long long)journal->identity.size, journal->m0, journal->m1, journal->qsource,
    journal->qmanifest, journal->newmanifest,
    (unsigned long long)journal->source_parent.dev, (unsigned long long)journal->source_parent.ino, (long long)journal->source_parent.size, (unsigned int)journal->source_parent.mode,
    (unsigned long long)journal->target_parent.dev, (unsigned long long)journal->target_parent.ino, (long long)journal->target_parent.size, (unsigned int)journal->target_parent.mode,
    (unsigned long long)journal->m0_identity.dev, (unsigned long long)journal->m0_identity.ino, (long long)journal->m0_identity.size,
    (unsigned long long)journal->m1_identity.dev, (unsigned long long)journal->m1_identity.ino, (long long)journal->m1_identity.size,
    (unsigned long long)journal->self_identity.dev, (unsigned long long)journal->self_identity.ino, (long long)self_size);
}

static int format_journal_payload(char *payload, size_t capacity, Journal *journal) {
  char body[24576];
  off_t candidate = journal->self_identity.size;
  int body_length = -1;
  for (size_t attempt = 0; attempt < 8; attempt += 1) {
    body_length = format_journal_body(body, sizeof(body), journal, candidate);
    if (body_length <= 0 || (size_t)body_length >= sizeof(body)) return -1;
    off_t total = (off_t)body_length + 1 + 64 + 1;
    if (total == candidate) break;
    candidate = total;
  }
  body_length = format_journal_body(body, sizeof(body), journal, candidate);
  if (body_length <= 0 || (size_t)body_length >= sizeof(body) ||
      (off_t)body_length + 66 != candidate) return -1;
  char digest[65];
  digest_hex((const unsigned char *)body, (size_t)body_length, digest);
  int length = snprintf(payload, capacity, "%s\t%s\n", body, digest);
  if (length <= 0 || (size_t)length >= capacity || (off_t)length != candidate) return -1;
  journal->self_identity.size = candidate;
  return length;
}

static bool write_journal(int trash_fd, const char *name, Journal *journal, bool create) {
  int flags = O_WRONLY | O_NOFOLLOW | O_CLOEXEC | (create ? (O_CREAT | O_EXCL) : 0);
  int fd = openat(trash_fd, name, flags, 0600);
  if (fd < 0) return false;
  struct stat opened, named;
  bool ok = fstat(fd, &opened) == 0 &&
    fstatat(trash_fd, name, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISREG(opened.st_mode) && S_ISREG(named.st_mode) &&
    opened.st_dev == named.st_dev && opened.st_ino == named.st_ino &&
    (opened.st_mode & 0777) == 0600 && (named.st_mode & 0777) == 0600;
  if (ok && create) {
    journal->self_identity.dev = opened.st_dev; journal->self_identity.ino = opened.st_ino;
    journal->self_identity.size = 0;
  }
  if (ok && !create) ok = journal_receipt_matches(&opened, journal);
  char payload[24576];
  int length = ok ? format_journal_payload(payload, sizeof(payload), journal) : -1;
  if (length <= 0) ok = false;
  if (ok) ok = ftruncate(fd, 0) == 0 && full_write(fd, payload, (size_t)length) && fsync(fd) == 0;
  if (ok) {
    struct stat after, current;
    ok = fstat(fd, &after) == 0 &&
      fstatat(trash_fd, name, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
      journal_receipt_matches(&after, journal) &&
      after.st_dev == current.st_dev && after.st_ino == current.st_ino &&
      after.st_size == current.st_size;
  }
  int close_result = close(fd);
  if (close_result != 0) ok = false;
  return ok && fsync(trash_fd) == 0;
}

static bool parse_journal(const unsigned char *bytes, size_t length, Journal *journal) {
  if (length < 67 || length >= 24576 || memchr(bytes, '\0', length) ||
      bytes[length - 1] != '\n') return false;
  size_t digest_separator = length - 66;
  if (bytes[digest_separator] != '\t') return false;
  char actual_digest[65];
  digest_hex(bytes, digest_separator, actual_digest);
  if (memcmp(bytes + digest_separator + 1, actual_digest, 64) != 0) return false;
  char copy[24576];
  memcpy(copy, bytes, length);
  copy[length] = '\0';
  char *fields[31] = {0};
  size_t count = 0;
  char *save = NULL;
  for (char *part = strtok_r(copy, "\t\n", &save); part && count < 31;
       part = strtok_r(NULL, "\t\n", &save)) fields[count++] = part;
  if (count != 31 || strlen(fields[0]) != 1 || !strchr("PQDMC", fields[0][0]) ||
      strlen(fields[1]) != 1 || !strchr("RT", fields[1][0]) || !hex_string(fields[4], 64) ||
      !hex_string(fields[8], 64) || !hex_string(fields[9], 64) || !safe_component(fields[10]) ||
      !safe_component(fields[11]) || !safe_component(fields[12]) || !hex_string(fields[30], 64)) return false;
  memset(journal, 0, sizeof(*journal));
  journal->state = fields[0][0];
  journal->operation = fields[1][0];
  if (strlen(fields[2]) >= sizeof(journal->source_hex) || strlen(fields[3]) >= sizeof(journal->target_hex)) return false;
  strcpy(journal->source_hex, fields[2]); strcpy(journal->target_hex, fields[3]);
  strcpy(journal->digest, fields[4]); strcpy(journal->m0, fields[8]); strcpy(journal->m1, fields[9]);
  strcpy(journal->qsource, fields[10]); strcpy(journal->qmanifest, fields[11]); strcpy(journal->newmanifest, fields[12]);
  char *end = NULL;
  journal->identity.dev = (dev_t)strtoull(fields[5], &end, 10); if (!end || *end) return false;
  journal->identity.ino = (ino_t)strtoull(fields[6], &end, 10); if (!end || *end) return false;
  journal->identity.size = (off_t)strtoll(fields[7], &end, 10); if (!end || *end || journal->identity.size < 0) return false;
  journal->source_parent.dev = (dev_t)strtoull(fields[13], &end, 10); if (!end || *end) return false;
  journal->source_parent.ino = (ino_t)strtoull(fields[14], &end, 10); if (!end || *end) return false;
  journal->source_parent.size = (off_t)strtoll(fields[15], &end, 10); if (!end || *end) return false;
  journal->source_parent.mode = (mode_t)strtoul(fields[16], &end, 10); if (!end || *end) return false;
  journal->target_parent.dev = (dev_t)strtoull(fields[17], &end, 10); if (!end || *end) return false;
  journal->target_parent.ino = (ino_t)strtoull(fields[18], &end, 10); if (!end || *end) return false;
  journal->target_parent.size = (off_t)strtoll(fields[19], &end, 10); if (!end || *end) return false;
  journal->target_parent.mode = (mode_t)strtoul(fields[20], &end, 10); if (!end || *end) return false;
  journal->m0_identity.dev = (dev_t)strtoull(fields[21], &end, 10); if (!end || *end) return false;
  journal->m0_identity.ino = (ino_t)strtoull(fields[22], &end, 10); if (!end || *end) return false;
  journal->m0_identity.size = (off_t)strtoll(fields[23], &end, 10); if (!end || *end) return false;
  journal->m1_identity.dev = (dev_t)strtoull(fields[24], &end, 10); if (!end || *end) return false;
  journal->m1_identity.ino = (ino_t)strtoull(fields[25], &end, 10); if (!end || *end) return false;
  journal->m1_identity.size = (off_t)strtoll(fields[26], &end, 10); if (!end || *end || journal->m1_identity.size < 0) return false;
  journal->self_identity.dev = (dev_t)strtoull(fields[27], &end, 10); if (!end || *end) return false;
  journal->self_identity.ino = (ino_t)strtoull(fields[28], &end, 10); if (!end || *end) return false;
  off_t encoded_self_size = (off_t)strtoll(fields[29], &end, 10); if (!end || *end || encoded_self_size < 0) return false;
  if ((size_t)encoded_self_size != length) return false;
  journal->self_identity.size = encoded_self_size;
  return true;
}

static bool request_matches(const Journal *journal, const Journal *requested) {
  return journal->operation == requested->operation && strcmp(journal->source_hex, requested->source_hex) == 0 &&
    strcmp(journal->target_hex, requested->target_hex) == 0 &&
    strcmp(journal->digest, requested->digest) == 0 &&
    strcmp(journal->m0, requested->m0) == 0 && strcmp(journal->m1, requested->m1) == 0 &&
    journal->identity.dev == requested->identity.dev && journal->identity.ino == requested->identity.ino &&
    journal->identity.size == requested->identity.size;
}

static bool journal_committed(int root_fd, int trash_fd, const Journal *journal) {
  unsigned char target[4097]; size_t target_length = 0;
  if (!hex_decode(journal->target_hex, target, sizeof(target) - 1, &target_length)) return false;
  target[target_length] = '\0';
  char leaf[256]; int parent = journal->operation == 'T' ? dup(trash_fd) :
    open_relative_parent(root_fd, (char *)target, leaf);
  if (journal->operation == 'T') {
    if (!safe_component((char *)target)) return false;
    strcpy(leaf, (char *)target);
  }
  if (parent < 0 || !same_bound_directory(parent, &journal->target_parent)) { if (parent >= 0) close(parent); return false; }
  struct stat target_stat;
  bool target_ok = read_source_at(parent, leaf, &journal->identity, journal->digest, &target_stat);
  close(parent);
  if (!target_ok) return false;
  unsigned char *manifest = NULL; size_t length = 0; struct stat stat; char digest[65];
  bool manifest_ok = read_regular_at(trash_fd, "manifest.json", &manifest, &length, &stat, digest) &&
    strcmp(digest, journal->m1) == 0 && stat_matches_file_identity(&stat, &journal->m1_identity);
  free(manifest);
  return manifest_ok;
}

static int bind_root(void) {
  struct stat root;
  if (fstat(PROJECT_ROOT_FD, &root) != 0 || !S_ISDIR(root.st_mode)) {
    fputs("P\tERR\tPATH\n", stdout); fflush(stdout); return 1;
  }
  printf("P\tOK\t%llu\t%llu\t%u\n", (unsigned long long)root.st_dev,
    (unsigned long long)root.st_ino, (unsigned int)root.st_mode); fflush(stdout);
  return 0;
}

static int list_manifest(unsigned long long sequence) {
  int trash = open_trash(PROJECT_ROOT_FD);
  if (trash < 0) {
    int code = errno;
    response("L", sequence, code == ENOENT ? "EMPTY" : "RECOVERY_REQUIRED");
    if (code == ENOENT) response("E", sequence, "OK");
    return 0;
  }
  unsigned char *bytes = NULL; size_t length = 0; struct stat stat; char digest[65];
  if (!read_regular_at(trash, "manifest.json", &bytes, &length, &stat, digest)) {
    int code = errno;
    close(trash); response("L", sequence, code == ENOENT ? "EMPTY" : "RECOVERY_REQUIRED");
    if (code == ENOENT) response("E", sequence, "OK");
    return 0;
  }
  printf("L\t%llu\tOK\t%zu\t%s\t%llu\t%llu\t%lld\n", sequence, length, digest,
    (unsigned long long)stat.st_dev, (unsigned long long)stat.st_ino, (long long)stat.st_size);
  for (size_t offset = 0; offset < length; offset += CHUNK_BYTES) {
    size_t count = length - offset < CHUNK_BYTES ? length - offset : CHUNK_BYTES;
    printf("D\t%llu\t", sequence);
    for (size_t index = 0; index < count; index += 1) printf("%02x", bytes[offset + index]);
    fputc('\n', stdout);
  }
  response("E", sequence, "OK");
  free(bytes); close(trash); return 0;
}

static int inspect_file(unsigned long long sequence, const char *source_hex, const char *maximum_text) {
  unsigned char source[4097]; size_t source_length = 0; char *end = NULL;
  unsigned long long maximum = strtoull(maximum_text, &end, 10);
  if (!end || *end || maximum > 16 * 1024 * 1024 || !hex_decode(source_hex, source, sizeof(source) - 1, &source_length)) {
    response("I", sequence, "SOURCE_STALE"); return 0;
  }
  source[source_length] = '\0';
  if (memchr(source, '\0', source_length) != NULL) { response("I", sequence, "SOURCE_STALE"); return 0; }
  char leaf[256]; int parent = open_relative_parent(PROJECT_ROOT_FD, (char *)source, leaf); struct stat stat; char digest[65];
  if (parent < 0 || !inspect_source_at(parent, leaf, (off_t)maximum, &stat, digest)) {
    if (parent >= 0) close(parent); response("I", sequence, "SOURCE_STALE"); return 0;
  }
  close(parent);
  printf("I\t%llu\tOK\t%s\t%llu\t%llu\t%lld\n", sequence, digest,
    (unsigned long long)stat.st_dev, (unsigned long long)stat.st_ino, (long long)stat.st_size);
  fflush(stdout); return 0;
}

static int operation_status(
  unsigned long long sequence, const char *operation, const char *source_hex, const char *target_hex,
  const char *digest, const char *dev, const char *ino, const char *size, const char *m0, const char *m1
) {
  if (strlen(operation) != 1 || !strchr("RT", operation[0]) || !hex_string(digest, 64) ||
      !hex_string(m0, 64) || !hex_string(m1, 64)) { operation_response("S", sequence, "UNCOMMITTED", "REQUEST_INVALID"); return 0; }
  Journal requested; memset(&requested, 0, sizeof(requested)); requested.operation = operation[0];
  if (strlen(source_hex) >= sizeof(requested.source_hex) || strlen(target_hex) >= sizeof(requested.target_hex)) { operation_response("S", sequence, "UNCOMMITTED", "REQUEST_INVALID"); return 0; }
  strcpy(requested.source_hex, source_hex); strcpy(requested.target_hex, target_hex); strcpy(requested.digest, digest); strcpy(requested.m0, m0); strcpy(requested.m1, m1);
  char *end = NULL; requested.identity.dev = (dev_t)strtoull(dev, &end, 10); if (!end || *end) { operation_response("S", sequence, "UNCOMMITTED", "REQUEST_INVALID"); return 0; }
  requested.identity.ino = (ino_t)strtoull(ino, &end, 10); if (!end || *end) { operation_response("S", sequence, "UNCOMMITTED", "REQUEST_INVALID"); return 0; }
  requested.identity.size = (off_t)strtoll(size, &end, 10); if (!end || *end || requested.identity.size < 0) { operation_response("S", sequence, "UNCOMMITTED", "REQUEST_INVALID"); return 0; }
  int trash = open_trash(PROJECT_ROOT_FD); if (trash < 0) { operation_response("S", sequence, "UNCOMMITTED", "NONE"); return 0; }
  DIR *directory = fdopendir(dup(trash)); if (!directory) { close(trash); operation_response("S", sequence, "RECOVERY_REQUIRED", "UNKNOWN"); return 0; }
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strncmp(entry->d_name, JOURNAL_PREFIX, strlen(JOURNAL_PREFIX)) != 0) continue;
    unsigned char *bytes = NULL; size_t length = 0; struct stat stat; char ignored[65]; Journal existing;
    bool readable = read_regular_at(trash, entry->d_name, &bytes, &length, &stat, ignored) && parse_journal(bytes, length, &existing) && journal_receipt_matches(&stat, &existing);
    free(bytes);
    if (!readable || !request_matches(&existing, &requested)) { closedir(directory); close(trash); operation_response("S", sequence, "RECOVERY_REQUIRED", "UNKNOWN"); return 0; }
    bool committed = existing.state == 'C' && journal_committed(PROJECT_ROOT_FD, trash, &existing);
    closedir(directory); close(trash); operation_response("S", sequence, committed ? "COMMITTED" : "RECOVERY_REQUIRED", committed ? "NONE" : "UNKNOWN"); return 0;
  }
  closedir(directory); close(trash); operation_response("S", sequence, "UNCOMMITTED", "NONE"); return 0;
}

static bool journal_source_parent(int root_fd, int trash_fd, const Journal *journal, int *parent_out, char leaf[256]) {
  unsigned char source[4097]; size_t length = 0;
  if (!hex_decode(journal->source_hex, source, sizeof(source) - 1, &length) || memchr(source, '\0', length)) return false;
  source[length] = '\0';
  if (journal->operation == 'R') {
    if (!safe_component((char *)source)) return false;
    *parent_out = dup(trash_fd); strcpy(leaf, (char *)source); return *parent_out >= 0 && same_bound_directory(*parent_out, &journal->source_parent);
  }
  *parent_out = open_relative_parent(root_fd, (char *)source, leaf); return *parent_out >= 0 && same_bound_directory(*parent_out, &journal->source_parent);
}

static bool journal_target_parent(int root_fd, int trash_fd, const Journal *journal, int *parent_out, char leaf[256]) {
  unsigned char target[4097]; size_t length = 0;
  if (!hex_decode(journal->target_hex, target, sizeof(target) - 1, &length) || memchr(target, '\0', length)) return false;
  target[length] = '\0';
  if (journal->operation == 'T') {
    if (!safe_component((char *)target)) return false;
    *parent_out = dup(trash_fd); strcpy(leaf, (char *)target); return *parent_out >= 0 && same_bound_directory(*parent_out, &journal->target_parent);
  }
  *parent_out = open_relative_parent(root_fd, (char *)target, leaf); return *parent_out >= 0 && same_bound_directory(*parent_out, &journal->target_parent);
}

static bool revalidate_journal_parents(
  int root_fd,
  int trash_fd,
  const Journal *journal,
  int source_parent,
  int target_parent
) {
  int fresh_source = -1, fresh_target = -1;
  char source_leaf[256], target_leaf[256];
  bool valid = revalidate_trash_parent(root_fd, trash_fd) &&
    journal_source_parent(root_fd, trash_fd, journal, &fresh_source, source_leaf) &&
    same_directory_fd(fresh_source, source_parent) &&
    journal_target_parent(root_fd, trash_fd, journal, &fresh_target, target_leaf) &&
    same_directory_fd(fresh_target, target_parent);
  if (fresh_source >= 0) close(fresh_source);
  if (fresh_target >= 0) close(fresh_target);
  return valid;
}

static bool remove_owned_file(int trash_fd, const char *name, const char *digest, const FileIdentity *expected) {
  unsigned char *bytes = NULL; size_t length = 0; struct stat stat; char actual[65];
  FileIdentity actual_identity;
  bool ok = read_regular_at(trash_fd, name, &bytes, &length, &stat, actual) && strcmp(actual, digest) == 0 &&
    file_identity_from_stat(&stat, &actual_identity) && actual_identity.dev == expected->dev && actual_identity.ino == expected->ino && actual_identity.size == expected->size;
  free(bytes); if (!ok) return false;
  struct stat at_path;
  if (fstatat(trash_fd, name, &at_path, AT_SYMLINK_NOFOLLOW) != 0 || !stat_matches_file_identity(&at_path, expected)) return false;
  char quarantine[96];
  if (!random_name(".writcraft-md-artifact-quarantine-", quarantine) ||
      renameatx_np(trash_fd, name, trash_fd, quarantine, RENAME_EXCL) != 0) return false;
  struct stat moved;
  if (fstatat(trash_fd, quarantine, &moved, AT_SYMLINK_NOFOLLOW) != 0 || !stat_matches_file_identity(&moved, expected)) return false;
  return unlinkat(trash_fd, quarantine, 0) == 0 && fsync(trash_fd) == 0;
}

static bool cleanup_committed_manifest_artifact(int trash_fd, const Journal *journal) {
  if (strcmp(journal->m0, ABSENT_MANIFEST_DIGEST) == 0 ||
      absent_at(trash_fd, journal->qmanifest)) return true;
  return remove_owned_file(
    trash_fd,
    journal->qmanifest,
    journal->m0,
    &journal->m0_identity
  );
}

static bool remove_journal_exact(int trash_fd, const char *name, const Journal *expected) {
  unsigned char *bytes = NULL; size_t length = 0; struct stat opened; char digest[65]; Journal parsed;
  bool ok = read_regular_at(trash_fd, name, &bytes, &length, &opened, digest) && parse_journal(bytes, length, &parsed) &&
    journal_receipt_matches(&opened, &parsed) && parsed.self_identity.dev == expected->self_identity.dev &&
    parsed.self_identity.ino == expected->self_identity.ino && parsed.self_identity.size == expected->self_identity.size;
  free(bytes); if (!ok) return false;
  struct stat at_path;
  if (fstatat(trash_fd, name, &at_path, AT_SYMLINK_NOFOLLOW) != 0 || !journal_receipt_matches(&at_path, expected)) return false;
  char quarantine[96];
  if (!random_name(".writcraft-md-journal-quarantine-", quarantine) ||
      renameatx_np(trash_fd, name, trash_fd, quarantine, RENAME_EXCL) != 0) return false;
  struct stat quarantined;
  if (fstatat(trash_fd, quarantine, &quarantined, AT_SYMLINK_NOFOLLOW) != 0 || !journal_receipt_matches(&quarantined, expected)) return false;
  return unlinkat(trash_fd, quarantine, 0) == 0 && fsync(trash_fd) == 0;
}

static const char *reconcile_one_journal(int root_fd, int trash_fd, const char *name, const Journal *journal) {
  int source_parent = -1, target_parent = -1; char source_leaf[256], target_leaf[256]; struct stat source_stat;
  if (!journal_source_parent(root_fd, trash_fd, journal, &source_parent, source_leaf) ||
      !journal_target_parent(root_fd, trash_fd, journal, &target_parent, target_leaf)) goto unknown;
  if (journal_committed(root_fd, trash_fd, journal)) {
    bool committed = journal_committed(root_fd, trash_fd, journal);
    close(source_parent); close(target_parent);
    if (!committed || !cleanup_committed_manifest_artifact(trash_fd, journal) ||
        !remove_journal_exact(trash_fd, name, journal)) return "RECOVERY_REQUIRED";
    return "COMMITTED";
  }
  if (journal->state == 'P' && manifest_matches(trash_fd, journal->m0) &&
      read_source_at(source_parent, source_leaf, &journal->identity, journal->digest, &source_stat) && absent_at(target_parent, target_leaf)) {
    close(source_parent); close(target_parent);
    if (!remove_owned_file(trash_fd, journal->newmanifest, journal->m1, &journal->m1_identity)) return "RECOVERY_REQUIRED";
    if (!remove_journal_exact(trash_fd, name, journal)) return "RECOVERY_REQUIRED"; return "UNCOMMITTED";
  }
  if ((journal->state == 'Q' || journal->state == 'P') && manifest_matches(trash_fd, journal->m0) &&
      absent_at(target_parent, target_leaf) && absent_at(source_parent, source_leaf) &&
      read_source_at(trash_fd, journal->qsource, &journal->identity, journal->digest, &source_stat)) {
#ifdef WRITCRAFT_TEST_RECOVER_ROLLBACK_PARENT_SWAP
    if (journal->operation == 'T') {
      (void)renameat(root_fd, "chapters", root_fd, "chapters-recovery-original-test");
      (void)mkdirat(root_fd, "chapters", 0700);
    }
#endif
    bool rolled_back = revalidate_journal_parents(root_fd, trash_fd, journal, source_parent, target_parent) &&
      manifest_matches(trash_fd, journal->m0) && absent_at(target_parent, target_leaf) &&
      absent_at(source_parent, source_leaf) &&
      read_source_at(trash_fd, journal->qsource, &journal->identity, journal->digest, &source_stat) &&
      renameatx_np(trash_fd, journal->qsource, source_parent, source_leaf, RENAME_EXCL) == 0 &&
      fsync(trash_fd) == 0 && fsync(source_parent) == 0;
    close(source_parent); close(target_parent);
    if (!rolled_back) return "RECOVERY_REQUIRED";
    if (!remove_owned_file(trash_fd, journal->newmanifest, journal->m1, &journal->m1_identity)) return "RECOVERY_REQUIRED";
    if (!remove_journal_exact(trash_fd, name, journal)) return "RECOVERY_REQUIRED"; return "UNCOMMITTED";
  }
  if ((journal->state == 'D' || journal->state == 'Q') && manifest_matches(trash_fd, journal->m0) &&
      read_source_at(target_parent, target_leaf, &journal->identity, journal->digest, &source_stat)) {
 #ifdef WRITCRAFT_TEST_RECOVER_ROLLFORWARD_PARENT_SWAP
    if (journal->operation == 'R') {
      (void)renameat(root_fd, "chapters", root_fd, "chapters-recovery-original-test");
      (void)mkdirat(root_fd, "chapters", 0700);
    }
 #endif
    struct stat m1stat;
    bool prepared = revalidate_journal_parents(root_fd, trash_fd, journal, source_parent, target_parent) &&
      manifest_matches(trash_fd, journal->m0) &&
      read_source_at(target_parent, target_leaf, &journal->identity, journal->digest, &source_stat) &&
      fstatat(trash_fd, journal->newmanifest, &m1stat, AT_SYMLINK_NOFOLLOW) == 0 &&
      stat_matches_file_identity(&m1stat, &journal->m1_identity);
    if (strcmp(journal->m0, ABSENT_MANIFEST_DIGEST) != 0) {
      unsigned char *m0bytes = NULL; size_t m0length = 0; struct stat m0stat; char m0digest[65];
      prepared = prepared &&
        read_regular_at(trash_fd, "manifest.json", &m0bytes, &m0length, &m0stat, m0digest) &&
        strcmp(m0digest, journal->m0) == 0 && stat_matches_file_identity(&m0stat, &journal->m0_identity);
      free(m0bytes);
      if (prepared) prepared = renameatx_np(trash_fd, "manifest.json", trash_fd, journal->qmanifest, RENAME_EXCL) == 0 && fsync(trash_fd) == 0 && manifest_matches(trash_fd, ABSENT_MANIFEST_DIGEST);
    }
    if (prepared) {
      prepared = revalidate_journal_parents(root_fd, trash_fd, journal, source_parent, target_parent) &&
        read_source_at(target_parent, target_leaf, &journal->identity, journal->digest, &source_stat) &&
        fstatat(trash_fd, journal->newmanifest, &m1stat, AT_SYMLINK_NOFOLLOW) == 0 &&
        stat_matches_file_identity(&m1stat, &journal->m1_identity) &&
        manifest_matches(trash_fd, ABSENT_MANIFEST_DIGEST);
    }
    if (prepared) {
      prepared = renameatx_np(trash_fd, journal->newmanifest, trash_fd, "manifest.json", RENAME_EXCL) == 0 &&
        fsync(trash_fd) == 0 && manifest_matches(trash_fd, journal->m1);
    }
    close(source_parent); close(target_parent);
    if (!prepared) return "RECOVERY_REQUIRED";
    if (strcmp(journal->m0, ABSENT_MANIFEST_DIGEST) != 0 && !remove_owned_file(trash_fd, journal->qmanifest, journal->m0, &journal->m0_identity)) return "RECOVERY_REQUIRED";
    if (!remove_journal_exact(trash_fd, name, journal)) return "RECOVERY_REQUIRED"; return "COMMITTED";
  }
  close(source_parent); close(target_parent);
unknown:
  if (source_parent >= 0) close(source_parent); if (target_parent >= 0) close(target_parent); return "RECOVERY_REQUIRED";
}

static int auto_reconcile(unsigned long long sequence) {
  int trash = open_trash(PROJECT_ROOT_FD);
  if (trash < 0) {
    int code = errno;
    response("A", sequence, code == ENOENT ? "CLEAR" : "RECOVERY_REQUIRED");
    return 0;
  }
  DIR *directory = fdopendir(dup(trash)); if (!directory) { close(trash); response("A", sequence, "RECOVERY_REQUIRED"); return 0; }
  size_t count = 0; char name[NAME_MAX + 1] = {0}; Journal journal; struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strncmp(entry->d_name, JOURNAL_PREFIX, strlen(JOURNAL_PREFIX)) != 0) continue;
    if (++count > 1) { closedir(directory); close(trash); response("A", sequence, "RECOVERY_REQUIRED"); return 0; }
    unsigned char *bytes = NULL; size_t length = 0; struct stat stat; char ignored[65];
    bool valid = read_regular_at(trash, entry->d_name, &bytes, &length, &stat, ignored) && parse_journal(bytes, length, &journal) && journal_receipt_matches(&stat, &journal);
    free(bytes); if (!valid) { closedir(directory); close(trash); response("A", sequence, "RECOVERY_REQUIRED"); return 0; }
    strcpy(name, entry->d_name);
  }
  closedir(directory); if (!count) { close(trash); response("A", sequence, "CLEAR"); return 0; }
  const char *state = reconcile_one_journal(PROJECT_ROOT_FD, trash, name, &journal); close(trash); response("A", sequence, state); return 0;
}

static int restore(
  unsigned long long sequence, const char *source_hex, const char *target_hex, const char *digest,
  const char *dev, const char *ino, const char *size, const char *m0, const char *next_hex
) {
  if (!hex_string(digest, 64) || !hex_string(m0, 64) || strlen(source_hex) >= 1024 ||
      strlen(target_hex) >= 8192 || strlen(next_hex) > MAX_MANIFEST_BYTES * 2) {
    response("R", sequence, "UNCOMMITTED"); return 0;
  }
  Journal requested; memset(&requested, 0, sizeof(requested));
  requested.state = 'P'; requested.operation = 'R'; strcpy(requested.source_hex, source_hex); strcpy(requested.target_hex, target_hex);
  strcpy(requested.digest, digest); strcpy(requested.m0, m0);
  char *end = NULL;
  requested.identity.dev = (dev_t)strtoull(dev, &end, 10); if (!end || *end) { response("R", sequence, "UNCOMMITTED"); return 0; }
  requested.identity.ino = (ino_t)strtoull(ino, &end, 10); if (!end || *end) { response("R", sequence, "UNCOMMITTED"); return 0; }
  requested.identity.size = (off_t)strtoll(size, &end, 10); if (!end || *end || requested.identity.size < 0) { response("R", sequence, "UNCOMMITTED"); return 0; }
  unsigned char next[MAX_MANIFEST_BYTES + 1]; size_t next_length = 0;
  if (!hex_decode(next_hex, next, MAX_MANIFEST_BYTES, &next_length)) { response("R", sequence, "UNCOMMITTED"); return 0; }
  digest_hex(next, next_length, requested.m1);
  unsigned char source_name[512]; size_t source_length = 0;
  unsigned char target[4097]; size_t target_length = 0;
  if (!hex_decode(source_hex, source_name, sizeof(source_name) - 1, &source_length) ||
      !hex_decode(target_hex, target, sizeof(target) - 1, &target_length)) { response("R", sequence, "UNCOMMITTED"); return 0; }
  source_name[source_length] = '\0'; target[target_length] = '\0';
  if (memchr(source_name, '\0', source_length) != NULL || memchr(target, '\0', target_length) != NULL ||
      !safe_component((char *)source_name)) { response("R", sequence, "UNCOMMITTED"); return 0; }
  int trash = open_trash(PROJECT_ROOT_FD);
  char target_leaf[256]; int target_parent = open_relative_parent(PROJECT_ROOT_FD, (char *)target, target_leaf);
  if (trash < 0 || target_parent < 0) { if (trash >= 0) close(trash); if (target_parent >= 0) close(target_parent); response("R", sequence, "UNCOMMITTED"); return 0; }

  // A matching completed journal is a durable receipt when the prior stdout response was lost.
  DIR *directory = fdopendir(dup(trash));
  if (!directory) { close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0; }
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strncmp(entry->d_name, JOURNAL_PREFIX, strlen(JOURNAL_PREFIX)) != 0) continue;
    unsigned char *journal_bytes = NULL; size_t journal_length = 0; struct stat journal_stat; char ignored[65]; Journal existing;
    bool readable = read_regular_at(trash, entry->d_name, &journal_bytes, &journal_length, &journal_stat, ignored) &&
      parse_journal(journal_bytes, journal_length, &existing) && journal_receipt_matches(&journal_stat, &existing);
    free(journal_bytes);
    if (!readable || !request_matches(&existing, &requested)) { closedir(directory); close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0; }
    if (existing.state == 'C' && journal_committed(PROJECT_ROOT_FD, trash, &existing)) {
      if (!cleanup_committed_manifest_artifact(trash, &existing) ||
          !remove_journal_exact(trash, entry->d_name, &existing)) { closedir(directory); close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0; }
      closedir(directory); close(trash); close(target_parent);
      response("R", sequence, "COMMITTED"); return 0;
    }
    closedir(directory); close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  closedir(directory);

  unsigned char *manifest = NULL; size_t manifest_length = 0; struct stat manifest_stat; char manifest_digest[65]; struct stat source_stat;
  if (!read_regular_at(trash, "manifest.json", &manifest, &manifest_length, &manifest_stat, manifest_digest) || strcmp(manifest_digest, requested.m0) != 0) {
    free(manifest); close(trash); close(target_parent); operation_response("R", sequence, "UNCOMMITTED", "MANIFEST_STALE"); return 0;
  }
  if (!read_source_at(trash, (char *)source_name, &requested.identity, digest, &source_stat)) {
    free(manifest); close(trash); close(target_parent); operation_response("R", sequence, "UNCOMMITTED", "SOURCE_STALE"); return 0;
  }
  if (!absent_at(target_parent, target_leaf)) {
    free(manifest); close(trash); close(target_parent); operation_response("R", sequence, "UNCOMMITTED", "TARGET_EXISTS"); return 0;
  }
  free(manifest);
  char journal_name[96], qsource[96], qmanifest[96], newmanifest[96];
  if (!random_name(JOURNAL_PREFIX, journal_name) ||
      !random_name(".writcraft-md-source-", qsource) ||
      !random_name(".writcraft-md-oldmanifest-", qmanifest) ||
      !random_name(".writcraft-md-newmanifest-", newmanifest)) {
    close(trash); close(target_parent); response("R", sequence, "UNCOMMITTED"); return 0;
  }
  // Fields are deliberately named by role below; names are private, random, and only journal-bound.
  strcpy(requested.qsource, qsource); strcpy(requested.qmanifest, qmanifest); strcpy(requested.newmanifest, newmanifest);
  if (!bound_from_fd(trash, &requested.source_parent) || !bound_from_fd(target_parent, &requested.target_parent) ||
      !file_identity_from_stat(&manifest_stat, &requested.m0_identity)) {
    close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  if (!write_private_manifest(trash, requested.newmanifest, next, next_length, requested.m1)) {
    close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  struct stat prepared_manifest;
  if (fstatat(trash, requested.newmanifest, &prepared_manifest, AT_SYMLINK_NOFOLLOW) != 0 ||
      !file_identity_from_stat(&prepared_manifest, &requested.m1_identity)) {
    close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  if (!write_journal(trash, journal_name, &requested, true)) { close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0; }
#ifdef WRITCRAFT_TEST_R_ANCESTOR_SWAP
  (void)renameat(PROJECT_ROOT_FD, "chapters", PROJECT_ROOT_FD, "chapters-original-test");
  (void)mkdirat(PROJECT_ROOT_FD, "chapters", 0755);
#endif
  if (!revalidate_trash_parent(PROJECT_ROOT_FD, trash) ||
      !revalidate_relative_parent(PROJECT_ROOT_FD, (char *)target, target_parent) ||
      !read_source_at(trash, (char *)source_name, &requested.identity, digest, &source_stat) ||
      !absent_at(target_parent, target_leaf) || !manifest_matches(trash, requested.m0)) {
    close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
#ifdef WRITCRAFT_TEST_CRASH_R_P
  close(trash); close(target_parent); return 0;
#endif
  if (renameatx_np(trash, (char *)source_name, trash, requested.qsource, RENAME_EXCL) != 0 || fsync(trash) != 0) {
    close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
#ifdef WRITCRAFT_TEST_CRASH_R_AFTER_SOURCE_RENAME
  close(trash); close(target_parent); return 0;
#endif
  if (!read_source_at(trash, requested.qsource, &requested.identity, digest, &source_stat)) {
    close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  requested.state = 'Q'; if (!write_journal(trash, journal_name, &requested, false)) { close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0; }
#ifdef WRITCRAFT_TEST_CRASH_R_Q
  close(trash); close(target_parent); return 0;
#endif
#ifdef WRITCRAFT_TEST_TARGET_RACE
  int race = openat(target_parent, target_leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (race >= 0) { (void)write(race, "race", 4); (void)close(race); }
#endif
  if (!revalidate_trash_parent(PROJECT_ROOT_FD, trash) ||
      !revalidate_relative_parent(PROJECT_ROOT_FD, (char *)target, target_parent) ||
      !read_source_at(trash, requested.qsource, &requested.identity, digest, &source_stat) ||
      !absent_at(target_parent, target_leaf)) {
    close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  if (renameatx_np(trash, requested.qsource, target_parent, target_leaf, RENAME_EXCL) != 0 || fsync(trash) != 0 || fsync(target_parent) != 0) {
    close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
#ifdef WRITCRAFT_TEST_CRASH_R_AFTER_TARGET_RENAME
  close(trash); close(target_parent); return 0;
#endif
  struct stat target_stat;
  if (fstatat(target_parent, target_leaf, &target_stat, AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_identity(&target_stat, &requested.identity)) {
    close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  requested.state = 'D'; if (!write_journal(trash, journal_name, &requested, false)) { close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0; }
#ifdef WRITCRAFT_TEST_CRASH_R_D
  close(trash); close(target_parent); return 0;
#endif
  if (renameatx_np(trash, "manifest.json", trash, requested.qmanifest, RENAME_EXCL) != 0 || fsync(trash) != 0) {
    close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  unsigned char *old_manifest = NULL; size_t old_manifest_length = 0; struct stat old_manifest_stat; char old_manifest_digest[65];
  if (!read_regular_at(trash, requested.qmanifest, &old_manifest, &old_manifest_length, &old_manifest_stat, old_manifest_digest) ||
      strcmp(old_manifest_digest, requested.m0) != 0 || !stat_matches_file_identity(&old_manifest_stat, &requested.m0_identity)) {
    free(old_manifest); close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  free(old_manifest);
  struct stat final_prepared;
  if (fstatat(trash, requested.newmanifest, &final_prepared, AT_SYMLINK_NOFOLLOW) != 0 ||
      !stat_matches_file_identity(&final_prepared, &requested.m1_identity) ||
      renameatx_np(trash, requested.newmanifest, trash, "manifest.json", RENAME_EXCL) != 0 || fsync(trash) != 0) {
    close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0;
  }
#ifdef WRITCRAFT_TEST_CRASH_R_AFTER_MANIFEST_PUBLISH
  close(trash); close(target_parent); return 0;
#endif
  requested.state = 'C'; if (!write_journal(trash, journal_name, &requested, false)) { close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0; }
  if (!remove_owned_file(trash, requested.qmanifest, requested.m0, &requested.m0_identity)) { close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0; }
#ifdef WRITCRAFT_TEST_DROP_COMMITTED_RESPONSE
  close(trash); close(target_parent); return 0;
#endif
  if (!remove_journal_exact(trash, journal_name, &requested)) { close(trash); close(target_parent); response("R", sequence, "RECOVERY_REQUIRED"); return 0; }
  close(trash); close(target_parent); response("R", sequence, "COMMITTED"); return 0;
}

static int trash_file(
  unsigned long long sequence, const char *source_hex, const char *target_hex, const char *digest,
  const char *dev, const char *ino, const char *size, const char *m0, const char *next_hex
) {
  if (!hex_string(digest, 64) || !hex_string(m0, 64) || strlen(source_hex) >= 8192 ||
      strlen(target_hex) >= 1024 || strlen(next_hex) > MAX_MANIFEST_BYTES * 2) {
    response("T", sequence, "UNCOMMITTED"); return 0;
  }
  Journal requested; memset(&requested, 0, sizeof(requested));
  requested.state = 'P'; requested.operation = 'T'; strcpy(requested.source_hex, source_hex); strcpy(requested.target_hex, target_hex);
  strcpy(requested.digest, digest); strcpy(requested.m0, m0);
  char *end = NULL;
  requested.identity.dev = (dev_t)strtoull(dev, &end, 10); if (!end || *end) { response("T", sequence, "UNCOMMITTED"); return 0; }
  requested.identity.ino = (ino_t)strtoull(ino, &end, 10); if (!end || *end) { response("T", sequence, "UNCOMMITTED"); return 0; }
  requested.identity.size = (off_t)strtoll(size, &end, 10); if (!end || *end || requested.identity.size < 0) { response("T", sequence, "UNCOMMITTED"); return 0; }
  unsigned char next[MAX_MANIFEST_BYTES + 1]; size_t next_length = 0;
  if (!hex_decode(next_hex, next, MAX_MANIFEST_BYTES, &next_length)) { response("T", sequence, "UNCOMMITTED"); return 0; }
  digest_hex(next, next_length, requested.m1);
  unsigned char source[4097]; size_t source_length = 0; unsigned char target_name[512]; size_t target_length = 0;
  if (!hex_decode(source_hex, source, sizeof(source) - 1, &source_length) ||
      !hex_decode(target_hex, target_name, sizeof(target_name) - 1, &target_length)) { response("T", sequence, "UNCOMMITTED"); return 0; }
  source[source_length] = '\0'; target_name[target_length] = '\0';
  if (memchr(source, '\0', source_length) != NULL || memchr(target_name, '\0', target_length) != NULL ||
      !safe_component((char *)target_name)) { response("T", sequence, "UNCOMMITTED"); return 0; }
  char source_leaf[256]; int source_parent = open_relative_parent(PROJECT_ROOT_FD, (char *)source, source_leaf);
  int trash = open_or_create_trash(PROJECT_ROOT_FD);
  if (source_parent < 0 || trash < 0) { if (source_parent >= 0) close(source_parent); if (trash >= 0) close(trash); response("T", sequence, "UNCOMMITTED"); return 0; }

  DIR *directory = fdopendir(dup(trash));
  if (!directory) { close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0; }
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strncmp(entry->d_name, JOURNAL_PREFIX, strlen(JOURNAL_PREFIX)) != 0) continue;
    unsigned char *journal_bytes = NULL; size_t journal_length = 0; struct stat journal_stat; char ignored[65]; Journal existing;
    bool readable = read_regular_at(trash, entry->d_name, &journal_bytes, &journal_length, &journal_stat, ignored) &&
      parse_journal(journal_bytes, journal_length, &existing) && journal_receipt_matches(&journal_stat, &existing);
    free(journal_bytes);
    if (!readable || !request_matches(&existing, &requested)) { closedir(directory); close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0; }
    if (existing.state == 'C' && journal_committed(PROJECT_ROOT_FD, trash, &existing)) {
      if (!cleanup_committed_manifest_artifact(trash, &existing) ||
          !remove_journal_exact(trash, entry->d_name, &existing)) { closedir(directory); close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0; }
      closedir(directory); close(source_parent); close(trash);
      response("T", sequence, "COMMITTED"); return 0;
    }
    closedir(directory); close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  closedir(directory);

  struct stat source_stat;
  if (!manifest_matches(trash, requested.m0)) {
    close(source_parent); close(trash); operation_response("T", sequence, "UNCOMMITTED", "MANIFEST_STALE"); return 0;
  }
  if (!read_source_at(source_parent, source_leaf, &requested.identity, digest, &source_stat)) {
    close(source_parent); close(trash); operation_response("T", sequence, "UNCOMMITTED", "SOURCE_STALE"); return 0;
  }
  if (!absent_at(trash, (char *)target_name)) {
    close(source_parent); close(trash); operation_response("T", sequence, "UNCOMMITTED", "TARGET_EXISTS"); return 0;
  }
  char journal_name[96], qsource[96], qmanifest[96], newmanifest[96];
  if (!random_name(JOURNAL_PREFIX, journal_name) || !random_name(".writcraft-md-source-", qsource) ||
      !random_name(".writcraft-md-oldmanifest-", qmanifest) || !random_name(".writcraft-md-newmanifest-", newmanifest)) {
    close(source_parent); close(trash); response("T", sequence, "UNCOMMITTED"); return 0;
  }
  strcpy(requested.qsource, qsource); strcpy(requested.qmanifest, qmanifest); strcpy(requested.newmanifest, newmanifest);
  if (!bound_from_fd(source_parent, &requested.source_parent) || !bound_from_fd(trash, &requested.target_parent)) {
    close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  if (strcmp(requested.m0, ABSENT_MANIFEST_DIGEST) == 0) {
    memset(&requested.m0_identity, 0, sizeof(requested.m0_identity));
  } else {
    unsigned char *m0bytes = NULL; size_t m0length = 0; struct stat m0stat; char m0digest[65];
    bool m0ok = read_regular_at(trash, "manifest.json", &m0bytes, &m0length, &m0stat, m0digest) &&
      strcmp(m0digest, requested.m0) == 0 && file_identity_from_stat(&m0stat, &requested.m0_identity);
    free(m0bytes); if (!m0ok) { close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0; }
  }
  if (!write_private_manifest(trash, requested.newmanifest, next, next_length, requested.m1)) {
    close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  struct stat prepared_manifest;
  if (fstatat(trash, requested.newmanifest, &prepared_manifest, AT_SYMLINK_NOFOLLOW) != 0 ||
      !file_identity_from_stat(&prepared_manifest, &requested.m1_identity)) {
    close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  if (!write_journal(trash, journal_name, &requested, true)) { close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0; }
#ifdef WRITCRAFT_TEST_T_ANCESTOR_SWAP
  (void)renameat(PROJECT_ROOT_FD, "chapters", PROJECT_ROOT_FD, "chapters-original-test");
  (void)mkdirat(PROJECT_ROOT_FD, "chapters", 0755);
#endif
  if (!revalidate_relative_parent(PROJECT_ROOT_FD, (char *)source, source_parent) ||
      !revalidate_trash_parent(PROJECT_ROOT_FD, trash) ||
      !read_source_at(source_parent, source_leaf, &requested.identity, digest, &source_stat) ||
      !absent_at(trash, (char *)target_name) || !manifest_matches(trash, requested.m0)) {
    close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0;
  }
#ifdef WRITCRAFT_TEST_CRASH_T_P
  close(source_parent); close(trash); return 0;
#endif
  if (renameatx_np(source_parent, source_leaf, trash, requested.qsource, RENAME_EXCL) != 0 || fsync(source_parent) != 0 || fsync(trash) != 0 ||
      !read_source_at(trash, requested.qsource, &requested.identity, digest, &source_stat)) {
    close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0;
  }
#ifdef WRITCRAFT_TEST_CRASH_T_AFTER_SOURCE_RENAME
  close(source_parent); close(trash); return 0;
#endif
  requested.state = 'Q'; if (!write_journal(trash, journal_name, &requested, false)) { close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0; }
#ifdef WRITCRAFT_TEST_CRASH_T_Q
  close(source_parent); close(trash); return 0;
#endif
#ifdef WRITCRAFT_TEST_TRASH_TARGET_RACE
  int race = openat(trash, (char *)target_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (race >= 0) { (void)write(race, "race", 4); (void)close(race); }
#endif
  if (!revalidate_trash_parent(PROJECT_ROOT_FD, trash) ||
      !read_source_at(trash, requested.qsource, &requested.identity, digest, &source_stat) ||
      !absent_at(trash, (char *)target_name)) {
    close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  if (renameatx_np(trash, requested.qsource, trash, (char *)target_name, RENAME_EXCL) != 0 || fsync(trash) != 0) {
    close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0;
  }
#ifdef WRITCRAFT_TEST_CRASH_T_AFTER_TARGET_RENAME
  close(source_parent); close(trash); return 0;
#endif
  struct stat target_stat;
  if (fstatat(trash, (char *)target_name, &target_stat, AT_SYMLINK_NOFOLLOW) != 0 || !same_identity(&target_stat, &requested.identity)) {
    close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  requested.state = 'D'; if (!write_journal(trash, journal_name, &requested, false)) { close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0; }
#ifdef WRITCRAFT_TEST_CRASH_T_D
  close(source_parent); close(trash); return 0;
#endif
  if (strcmp(requested.m0, ABSENT_MANIFEST_DIGEST) != 0 &&
      (renameatx_np(trash, "manifest.json", trash, requested.qmanifest, RENAME_EXCL) != 0 || fsync(trash) != 0)) {
    close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  unsigned char *old_manifest = NULL; size_t old_manifest_length = 0; struct stat old_manifest_stat; char old_manifest_digest[65];
  if (strcmp(requested.m0, ABSENT_MANIFEST_DIGEST) != 0 &&
      (!read_regular_at(trash, requested.qmanifest, &old_manifest, &old_manifest_length, &old_manifest_stat, old_manifest_digest) || strcmp(old_manifest_digest, requested.m0) != 0 || !stat_matches_file_identity(&old_manifest_stat, &requested.m0_identity))) {
    free(old_manifest); close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0;
  }
  free(old_manifest);
  struct stat final_prepared;
  if (fstatat(trash, requested.newmanifest, &final_prepared, AT_SYMLINK_NOFOLLOW) != 0 ||
      !stat_matches_file_identity(&final_prepared, &requested.m1_identity) ||
      renameatx_np(trash, requested.newmanifest, trash, "manifest.json", RENAME_EXCL) != 0 || fsync(trash) != 0) {
    close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0;
  }
#ifdef WRITCRAFT_TEST_CRASH_T_AFTER_MANIFEST_PUBLISH
  close(source_parent); close(trash); return 0;
#endif
  requested.state = 'C'; if (!write_journal(trash, journal_name, &requested, false)) { close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0; }
  if (strcmp(requested.m0, ABSENT_MANIFEST_DIGEST) != 0 && !remove_owned_file(trash, requested.qmanifest, requested.m0, &requested.m0_identity)) { close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0; }
#ifdef WRITCRAFT_TEST_DROP_TRASH_COMMITTED_RESPONSE
  close(source_parent); close(trash); return 0;
#endif
  if (!remove_journal_exact(trash, journal_name, &requested)) { close(source_parent); close(trash); response("T", sequence, "RECOVERY_REQUIRED"); return 0; }
  close(source_parent); close(trash); response("T", sequence, "COMMITTED"); return 0;
}

int main(void) {
  char *line = malloc(MAX_LINE_BYTES + 1);
  if (!line) return 1;
  if (!fgets(line, MAX_LINE_BYTES + 1, stdin) || strcmp(line, "P\n") != 0) { fputs("P\tERR\tPROTOCOL\n", stdout); free(line); return 1; }
  if (bind_root() != 0) { free(line); return 1; }
  while (fgets(line, MAX_LINE_BYTES + 1, stdin)) {
    size_t length = strlen(line); if (!length || line[length - 1] != '\n') { free(line); return 1; }
    line[length - 1] = '\0';
    char *fields[11] = {0}; size_t count = 0; char *save = NULL;
    for (char *part = strtok_r(line, "\t", &save); part && count < 11; part = strtok_r(NULL, "\t", &save)) fields[count++] = part;
    char *end = NULL;
    if (count >= 2 && (strcmp(fields[0], "L") == 0 || strcmp(fields[0], "I") == 0 || strcmp(fields[0], "R") == 0 || strcmp(fields[0], "T") == 0 || strcmp(fields[0], "S") == 0 || strcmp(fields[0], "A") == 0)) {
      unsigned long long sequence = strtoull(fields[1], &end, 10);
      if (!end || *end) { free(line); return 1; }
      if (strcmp(fields[0], "L") == 0 && count == 2) { list_manifest(sequence); continue; }
      if (strcmp(fields[0], "A") == 0 && count == 2) { auto_reconcile(sequence); continue; }
      if (strcmp(fields[0], "I") == 0 && count == 4) { inspect_file(sequence, fields[2], fields[3]); continue; }
      if (strcmp(fields[0], "R") == 0 && count == 10) {
        restore(sequence, fields[2], fields[3], fields[4], fields[5], fields[6], fields[7], fields[8], fields[9]); continue;
      }
      if (strcmp(fields[0], "T") == 0 && count == 10) {
        trash_file(sequence, fields[2], fields[3], fields[4], fields[5], fields[6], fields[7], fields[8], fields[9]); continue;
      }
      if (strcmp(fields[0], "S") == 0 && count == 11) {
        operation_status(sequence, fields[2], fields[3], fields[4], fields[5], fields[6], fields[7], fields[8], fields[9], fields[10]); continue;
      }
    }
    free(line); return 1;
  }
  free(line); return 0;
}
