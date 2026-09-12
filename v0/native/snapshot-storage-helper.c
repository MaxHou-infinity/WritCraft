#define _DARWIN_C_SOURCE

// WritCraft snapshot storage helper: Stage A1 root-bound snapshot authority.
//
// The helper proves:
//   * startup binding from a Main-owned filesystem-root fd (fd 3),
//   * no-follow binding and revalidation of the absolute project root,
//   * descriptor-relative binding of the fixed private storage tree,
//   * same-scan sealed Markdown capture plus selected-image capture,
//   * canonical native bundle generation and formal transaction records,
//   * O_EXCL creation of one 0600 regular-file stage,
//   * bounded sequential writes, fsync, reopen and full SHA-256 verification,
//   * exact-owned cancellation with control-directory fsync and zero publish,
//   * frozen bundle framing/hash validation before no-clobber publish,
//   * durable create receipt/recovery records and disk reconciliation,
//   * committed-only list projection,
//   * exact receipt-bound quarantine deletion and fresh-worker reconciliation.
//
// It does not implement Markdown restore. In particular, an EOF/crash with a
// live stage or delete transaction never triggers speculative cleanup; a new
// worker must reconcile the formal control records.
//
// Strict LF-terminated private protocol (path is lowercase hex UTF-8 bytes):
//   P<TAB>absolute-project-path-hex
//   D
//   I
//   S<TAB>transaction-id<TAB>snapshot-id<TAB>stage-basename<TAB>exact-bytes
//   W<TAB>transaction-id<TAB>chunk-hex
//   F<TAB>transaction-id<TAB>snapshot-manifest-digest
//   C<TAB>transaction-id
//   A<TAB>transaction-id<TAB>final-basename<TAB>timestamp
//   R<TAB>transaction-id<TAB>snapshot-id<TAB>stage-basename<TAB>final-basename<TAB>timestamp
//   G<TAB>transaction-id<TAB>project-instance-id<TAB>snapshot-id<TAB>owner-generation
//     <TAB>mutation-generation<TAB>created-at
//   T<TAB>transaction-id<TAB>exact-token-pass-bytes
//   U<TAB>transaction-id<TAB>token-pass-chunk-hex
//   K<TAB>transaction-id
//   B<TAB>transaction-id
//   L
//   O<TAB>snapshot-id
//   Y<TAB>transaction-id<TAB>project-instance-id<TAB>snapshot-id<TAB>owner-generation
//     <TAB>snapshot-manifest-digest<TAB>published-identity-digest<TAB>committed-at
//   Z<TAB>transaction-id<TAB>project-instance-id<TAB>snapshot-id<TAB>owner-generation
//     <TAB>snapshot-manifest-digest<TAB>published-identity-digest<TAB>observed-at
//   X
//
// Stable errors never include paths or content.

#include <CommonCrypto/CommonDigest.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef WRITCRAFT_APP_VERSION
#error "WRITCRAFT_APP_VERSION must be injected from v0/package.json"
#endif

#define TRUSTED_ROOT_FD 3
#define MAX_PATH_BYTES 4096U
#define MAX_ROOT_COMPONENTS 128U
#define MAX_OPAQUE_BYTES 128U
#define MAX_STAGE_NAME_BYTES 96U
#define MAX_CHUNK_BYTES (64U * 1024U)
#define MAX_BUNDLE_BYTES (520ULL * 1024ULL * 1024ULL)
#define MAX_LINE_BYTES ((MAX_CHUNK_BYTES * 2U) + 512U)
#define HASH_CHUNK_BYTES (64U * 1024U)
#define MAX_MANIFEST_BYTES (4U * 1024U * 1024U)
#define MAX_HEADER_BYTES (4U * 1024U * 1024U)
#define MAX_CONTENT_BYTES (512ULL * 1024ULL * 1024ULL)
#define MAX_ENTRIES 500U
#define MAX_COMMITTED_SNAPSHOTS 20U
#ifndef WRITCRAFT_TEST_MAX_COMMITTED_PRIVATE_BYTES
#define MAX_COMMITTED_PRIVATE_BYTES (2ULL * 1024ULL * 1024ULL * 1024ULL)
#else
#define MAX_COMMITTED_PRIVATE_BYTES WRITCRAFT_TEST_MAX_COMMITTED_PRIVATE_BYTES
#endif
#define MAX_UNAVAILABLE_DETAILS 256U
#define MAX_RECORD_BYTES (1024U * 1024U)
#define DIGEST_TEXT_BYTES 71U
#define MAX_SCAN_ENTRIES 50000U
#define MAX_SAFE_INTEGER 9007199254740991ULL
#define MAX_TOKEN_PASS_BYTES (4U * 1024U * 1024U)
#define MAX_IMAGE_TOKENS 10000U
#define MAX_CAPTURE_IMAGES 200U

#if defined(WRITCRAFT_TEST_PAUSE_PRODUCTION_BEFORE_RENAME) || \
    defined(WRITCRAFT_TEST_PAUSE_RECONCILE_AFTER_FINAL_ABSENT) || \
    defined(WRITCRAFT_TEST_PAUSE_COMMITTED_READ_BEFORE_TERMINAL) || \
    defined(WRITCRAFT_TEST_PAUSE_COMMITTED_LIST_BEFORE_TERMINAL) || \
    defined(WRITCRAFT_TEST_PAUSE_DELETE_BEFORE_RENAME) || \
    defined(WRITCRAFT_TEST_PAUSE_DELETE_AFTER_RENAME) || \
    defined(WRITCRAFT_TEST_PAUSE_DELETE_BEFORE_UNLINK) || \
    defined(WRITCRAFT_TEST_PAUSE_DELETE_AFTER_UNLINK)
static bool test_sync_point(const char *name) {
  const char *directory = getenv("WRITCRAFT_TEST_SYNC_DIR");
  if (directory == NULL || directory[0] != '/' || strlen(directory) > 3000U ||
      strchr(directory, '\n') != NULL) return false;
  char ready[MAX_PATH_BYTES + 1U];
  char release[MAX_PATH_BYTES + 1U];
  int ready_length = snprintf(ready, sizeof(ready), "%s/%s.ready", directory, name);
  int release_length = snprintf(release, sizeof(release), "%s/%s.release", directory, name);
  if (ready_length <= 0 || (size_t)ready_length >= sizeof(ready) ||
      release_length <= 0 || (size_t)release_length >= sizeof(release)) return false;
  int fd = open(ready, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  if (fd < 0 || close(fd) != 0) return false;
  for (size_t attempt = 0U; attempt < 30000U; attempt += 1U) {
    if (access(release, F_OK) == 0) return true;
    if (errno != ENOENT) return false;
    (void)usleep(1000U);
  }
  return false;
}
#endif
#define MAX_CAPTURE_IMAGE_BYTES (25ULL * 1024ULL * 1024ULL)
#define MAX_CAPTURE_TOTAL_BYTES (512ULL * 1024ULL * 1024ULL)

static const char SNAPSHOT_PARSER_ID[] =
  "marked@18.0.6+sha256:62ad5de5bea6d79b4c47e5c0b5cbe4be61e25ee8994595c2cc0969b2a144cc5d";

static const unsigned char BUNDLE_MAGIC[8] = {0x57, 0x43, 0x53, 0x42, 0x01, 0x00, 0x00, 0x00};
static const unsigned char BUNDLE_FOOTER[8] = {0x57, 0x43, 0x53, 0x42, 0x45, 0x4e, 0x44, 0x01};

typedef struct {
  uintmax_t dev;
  uintmax_t ino;
  uintmax_t uid;
  uintmax_t mode;
  uintmax_t nlink;
  uintmax_t size;
  intmax_t mtime_ns;
  intmax_t ctime_ns;
} Identity;

typedef struct {
  char path[MAX_PATH_BYTES + 1U];
  size_t component_count;
  Identity components[MAX_ROOT_COMPONENTS];
  int project_fd;
  char root_identity_digest[DIGEST_TEXT_BYTES + 1U];
} RootBinding;

typedef struct {
  Identity control_identity;
  Identity bundles_identity;
  Identity quarantine_identity;
  int control_fd;
  int bundles_fd;
  int quarantine_fd;
  char control_identity_digest[DIGEST_TEXT_BYTES + 1U];
  char bundles_identity_digest[DIGEST_TEXT_BYTES + 1U];
  char quarantine_identity_digest[DIGEST_TEXT_BYTES + 1U];
  bool ready;
} StorageBinding;

typedef struct {
  char transaction_id[MAX_OPAQUE_BYTES + 1U];
  char snapshot_id[MAX_OPAQUE_BYTES + 1U];
  char basename[MAX_STAGE_NAME_BYTES + 1U];
  uint64_t expected_bytes;
  Identity initial_identity;
  unsigned char file_sha256[CC_SHA256_DIGEST_LENGTH];
  unsigned char payload_sha256[CC_SHA256_DIGEST_LENGTH];
  char snapshot_manifest_digest[DIGEST_TEXT_BYTES + 1U];
  char reservation_name[96];
  int reservation_fd;
  int fd;
  bool active;
  bool finalized;
} Stage;

typedef struct {
  char snapshot_id[MAX_OPAQUE_BYTES + 1U];
  char snapshot_manifest_digest[DIGEST_TEXT_BYTES + 1U];
  unsigned char payload_sha256[CC_SHA256_DIGEST_LENGTH];
  uint64_t payload_length;
} BundleInfo;

typedef struct {
  char transaction_id[MAX_OPAQUE_BYTES + 1U];
  char snapshot_id[MAX_OPAQUE_BYTES + 1U];
  char published_identity_digest[DIGEST_TEXT_BYTES + 1U];
  char snapshot_manifest_digest[DIGEST_TEXT_BYTES + 1U];
  char committed_at[97];
  char receipt_digest[DIGEST_TEXT_BYTES + 1U];
} ReceiptRecord;

typedef struct {
  char transaction_id[MAX_OPAQUE_BYTES + 1U];
  char snapshot_id[MAX_OPAQUE_BYTES + 1U];
  char expected_manifest_digest[DIGEST_TEXT_BYTES + 1U];
  char expected_published_identity_digest[DIGEST_TEXT_BYTES + 1U];
  char state[16];
  char updated_at[97];
  char marker_digest[DIGEST_TEXT_BYTES + 1U];
} RecoveryRecord;

typedef struct {
  char transaction_id[MAX_OPAQUE_BYTES + 1U];
  char snapshot_id[MAX_OPAQUE_BYTES + 1U];
  char stage_basename[MAX_STAGE_NAME_BYTES + 1U];
  uint64_t expected_bytes;
  Identity identity;
  char record_digest[DIGEST_TEXT_BYTES + 1U];
} StageReservation;

typedef struct {
  char transaction_id[MAX_OPAQUE_BYTES + 1U];
  char project_instance_id[34];
  char snapshot_id[MAX_OPAQUE_BYTES + 1U];
  uint64_t owner_generation;
  char state[16];
  char stage_identity_digest[DIGEST_TEXT_BYTES + 1U];
  char snapshot_manifest_digest[DIGEST_TEXT_BYTES + 1U];
  char receipt_digest[DIGEST_TEXT_BYTES + 1U];
  char created_at[97];
  char updated_at[97];
} CreateTransactionRecord;

typedef struct {
  char transaction_id[MAX_OPAQUE_BYTES + 1U];
  char project_instance_id[34];
  char snapshot_id[MAX_OPAQUE_BYTES + 1U];
  uint64_t owner_generation;
  char state[16];
  char source_identity_digest[DIGEST_TEXT_BYTES + 1U];
  char quarantine_identity_digest[DIGEST_TEXT_BYTES + 1U];
  char snapshot_manifest_digest[DIGEST_TEXT_BYTES + 1U];
  char created_at[97];
  char updated_at[97];
  char receipt_digest[DIGEST_TEXT_BYTES + 1U];
  char last_error_code[65];
} DeleteTransactionRecord;

typedef struct {
  char transaction_id[MAX_OPAQUE_BYTES + 1U];
  char snapshot_id[MAX_OPAQUE_BYTES + 1U];
  char deleted_identity_digest[DIGEST_TEXT_BYTES + 1U];
  char snapshot_manifest_digest[DIGEST_TEXT_BYTES + 1U];
  char committed_at[97];
  char receipt_digest[DIGEST_TEXT_BYTES + 1U];
} DeleteReceiptRecord;

typedef struct {
  char transaction_id[MAX_OPAQUE_BYTES + 1U];
  char snapshot_id[MAX_OPAQUE_BYTES + 1U];
  char expected_manifest_digest[DIGEST_TEXT_BYTES + 1U];
  char expected_deleted_identity_digest[DIGEST_TEXT_BYTES + 1U];
  char state[16];
  char updated_at[97];
  char marker_digest[DIGEST_TEXT_BYTES + 1U];
} DeleteRecoveryRecord;

typedef enum {
  CAPTURE_MARKDOWN = 1,
  CAPTURE_IMAGE = 2,
} CaptureEntryKind;

typedef struct {
  CaptureEntryKind kind;
  char path[MAX_PATH_BYTES + 1U];
  char opaque_id[MAX_OPAQUE_BYTES + 1U];
  char candidate_id[MAX_OPAQUE_BYTES + 1U];
  uint64_t byte_length;
  Identity identity;
  char ancestor_identity_digest[DIGEST_TEXT_BYTES + 1U];
  char source_object_identity_digest[DIGEST_TEXT_BYTES + 1U];
  char content_sha256[DIGEST_TEXT_BYTES + 1U];
  char bundle_object_digest[DIGEST_TEXT_BYTES + 1U];
  unsigned char *bytes;
} CaptureEntry;

typedef struct {
  unsigned char *bytes;
  size_t length;
  size_t capacity;
} ByteBuffer;

typedef struct {
  char from_file_id[MAX_OPAQUE_BYTES + 1U];
  uint64_t token_ordinal;
  char raw_token_sha256[DIGEST_TEXT_BYTES + 1U];
  char locator_digest[DIGEST_TEXT_BYTES + 1U];
  char resolved_path[MAX_PATH_BYTES + 1U];
} CaptureImageReference;

typedef struct {
  char transaction_id[MAX_OPAQUE_BYTES + 1U];
  char project_instance_id[34];
  char snapshot_id[MAX_OPAQUE_BYTES + 1U];
  uint64_t owner_generation;
  uint64_t mutation_generation;
  char created_at[97];
  char capture_id[MAX_OPAQUE_BYTES + 1U];
  char capture_digest[DIGEST_TEXT_BYTES + 1U];
  CaptureEntry *entries;
  size_t entry_count;
  size_t markdown_count;
  size_t image_count;
  uint64_t markdown_bytes;
  uint64_t image_bytes;
  size_t scanned_entries;
  unsigned char *token_pass_bytes;
  size_t token_pass_expected;
  size_t token_pass_used;
  CaptureImageReference *image_references;
  size_t image_reference_count;
  size_t image_token_count;
  bool active;
} SealedCapture;

typedef struct {
  char name[256];
  Identity identity;
  int fd;
} ScanAncestor;

typedef enum {
  LINE_EOF = 0,
  LINE_OK = 1,
  LINE_INVALID = 2,
  LINE_IO = 3,
} LineResult;

static void digest_hex(
  const unsigned char digest[CC_SHA256_DIGEST_LENGTH],
  char out[(CC_SHA256_DIGEST_LENGTH * 2U) + 1U]
);
static bool digest_domain(
  const char *schema,
  const char *canonical,
  char out[DIGEST_TEXT_BYTES + 1U]
);
static uintmax_t permission_mode(uintmax_t mode);
static bool create_control_record(
  const StorageBinding *storage,
  const char *name,
  const char *bytes,
  int *fd_out
);
static bool remove_owned_control(const StorageBinding *storage, const char *name, int fd);
static bool cleanup_live_stage(StorageBinding *storage, Stage *stage);
static bool production_names(
  const char *transaction_id,
  const char *snapshot_id,
  char transaction_name[96],
  char stage_name[96],
  char final_name[96]
);
static bool make_create_transaction_json(
  const SealedCapture *capture,
  const char *state,
  const char *stage_identity_digest,
  const char *manifest_digest,
  const char *receipt_digest,
  const char *last_error_code,
  char *out,
  size_t capacity
);
static bool compute_stage_identity_digest(
  const StorageBinding *storage,
  const Stage *stage,
  const Identity *identity,
  const char *payload_digest,
  const char *manifest_digest,
  char out[DIGEST_TEXT_BYTES + 1U]
);

static bool reservation_name(const char *transaction_id, char out[96]) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  char hex[(CC_SHA256_DIGEST_LENGTH * 2U) + 1U];
  CC_SHA256(transaction_id, (CC_LONG)strlen(transaction_id), digest);
  digest_hex(digest, hex);
  int length = snprintf(out, 96U, "stage-reservation-%s.json", hex);
  return length > 0 && length < 96;
}

// This private record is a transitional native ownership bind. The frozen
// writcraft.snapshot-transaction/v1 record needs Main-owned fields that the S
// protocol does not receive, so this must not be presented as that contract.
static bool make_stage_reservation_json(
  const StageReservation *record,
  char *out,
  size_t capacity,
  char digest_out[DIGEST_TEXT_BYTES + 1U]
) {
  char without_digest[2048];
  int plain_length = snprintf(
    without_digest,
    sizeof(without_digest),
    "{\"dev\":\"%" PRIuMAX "\",\"expectedBytes\":\"%" PRIu64
    "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX
    ",\"nlink\":%" PRIuMAX ",\"schema\":\"writcraft.snapshot-stage-reservation/v1\""
    ",\"snapshotId\":\"%s\",\"stageBasename\":\"%s\",\"transactionId\":\"%s\""
    ",\"uid\":%" PRIuMAX "}",
    record->identity.dev,
    record->expected_bytes,
    record->identity.ino,
    permission_mode(record->identity.mode),
    record->identity.nlink,
    record->snapshot_id,
    record->stage_basename,
    record->transaction_id,
    record->identity.uid
  );
  if (plain_length <= 0 || (size_t)plain_length >= sizeof(without_digest) ||
      !digest_domain("writcraft.snapshot-stage-reservation/v1", without_digest, digest_out)) {
    return false;
  }
  int length = snprintf(
    out,
    capacity,
    "{\"dev\":\"%" PRIuMAX "\",\"expectedBytes\":\"%" PRIu64
    "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX
    ",\"nlink\":%" PRIuMAX ",\"recordDigest\":\"%s\""
    ",\"schema\":\"writcraft.snapshot-stage-reservation/v1\",\"snapshotId\":\"%s\""
    ",\"stageBasename\":\"%s\",\"transactionId\":\"%s\",\"uid\":%" PRIuMAX "}\n",
    record->identity.dev,
    record->expected_bytes,
    record->identity.ino,
    permission_mode(record->identity.mode),
    record->identity.nlink,
    digest_out,
    record->snapshot_id,
    record->stage_basename,
    record->transaction_id,
    record->identity.uid
  );
  return length > 0 && (size_t)length < capacity && (size_t)length <= MAX_RECORD_BYTES;
}

static bool write_line(const char *line) {
  return fputs(line, stdout) != EOF && fflush(stdout) == 0;
}

static bool write_error(char command, const char *code) {
  char line[128];
  int length = snprintf(line, sizeof(line), "%c\tERR\t%s\n", command, code);
  return length > 0 && (size_t)length < sizeof(line) && write_line(line);
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
  out->uid = (uintmax_t)value->st_uid;
  out->mode = (uintmax_t)value->st_mode;
  out->nlink = (uintmax_t)value->st_nlink;
  out->size = (uintmax_t)value->st_size;
  return true;
}

static bool same_directory(const Identity *left, const Identity *right) {
  return left->dev == right->dev &&
    left->ino == right->ino &&
    left->uid == right->uid &&
    left->mode == right->mode &&
    S_ISDIR((mode_t)left->mode) &&
    S_ISDIR((mode_t)right->mode);
}

static bool same_regular_identity(const Identity *left, const Identity *right) {
  return left->dev == right->dev &&
    left->ino == right->ino &&
    left->uid == right->uid &&
    left->mode == right->mode &&
    left->nlink == right->nlink &&
    left->size == right->size &&
    left->mtime_ns == right->mtime_ns &&
    left->ctime_ns == right->ctime_ns &&
    S_ISREG((mode_t)left->mode) &&
    S_ISREG((mode_t)right->mode);
}

static bool same_file_object(const Identity *left, const Identity *right) {
  return left->dev == right->dev && left->ino == right->ino && left->uid == right->uid &&
    left->mode == right->mode && left->nlink == right->nlink && left->size == right->size &&
    S_ISREG((mode_t)left->mode) && S_ISREG((mode_t)right->mode);
}

static uintmax_t permission_mode(uintmax_t mode) {
  return mode & 07777U;
}

static bool digest_domain(const char *schema, const char *canonical, char out[DIGEST_TEXT_BYTES + 1U]) {
  static const char domain[] = "writcraft-digest/v1";
  CC_SHA256_CTX context;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  unsigned char zero = 0U;
  CC_SHA256_Init(&context);
  CC_SHA256_Update(&context, domain, (CC_LONG)(sizeof(domain) - 1U));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, schema, (CC_LONG)strlen(schema));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, canonical, (CC_LONG)strlen(canonical));
  CC_SHA256_Final(digest, &context);
  memcpy(out, "sha256:", 7U);
  digest_hex(digest, out + 7U);
  return true;
}

static void sha256_prefixed(const unsigned char *bytes, size_t length, char out[DIGEST_TEXT_BYTES + 1U]) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes, (CC_LONG)length, digest);
  memcpy(out, "sha256:", 7U);
  digest_hex(digest, out + 7U);
}

static bool safe_timestamp(const char *value) {
  size_t length = value == NULL ? 0U : strlen(value);
  if (length == 0U || length > 96U) return false;
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor += 1U) {
    if (!((*cursor >= '0' && *cursor <= '9') || *cursor == '-' || *cursor == ':' ||
          *cursor == '.' || *cursor == 'T' || *cursor == 'Z' || *cursor == '+')) return false;
  }
  return true;
}

static bool compute_root_identity_digest(const Identity *identity, char out[DIGEST_TEXT_BYTES + 1U]) {
  char canonical[512];
  int length = snprintf(
    canonical,
    sizeof(canonical),
    "{\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX
    "\",\"mode\":%" PRIuMAX ",\"schema\":\"writcraft.root-identity/v1\",\"uid\":%" PRIuMAX "}",
    identity->dev,
    identity->ino,
    permission_mode(identity->mode),
    identity->uid
  );
  return length > 0 && (size_t)length < sizeof(canonical) &&
    digest_domain("writcraft.root-identity/v1", canonical, out);
}

static bool compute_parent_identity_digest(
  const char *role,
  const char *root_digest,
  const Identity *identity,
  char out[DIGEST_TEXT_BYTES + 1U]
) {
  char canonical[768];
  int length = snprintf(
    canonical,
    sizeof(canonical),
    "{\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX
    "\",\"mode\":%" PRIuMAX ",\"role\":\"%s\",\"rootIdentityDigest\":\"%s\","
    "\"schema\":\"writcraft.snapshot-private-parent-identity/v1\",\"uid\":%" PRIuMAX "}",
    identity->dev,
    identity->ino,
    permission_mode(identity->mode),
    role,
    root_digest,
    identity->uid
  );
  return length > 0 && (size_t)length < sizeof(canonical) &&
    digest_domain("writcraft.snapshot-private-parent-identity/v1", canonical, out);
}

static bool decimal_uint64(const char *value, uint64_t *out) {
  if (value == NULL || value[0] == '\0') return false;
  if (value[0] == '0' && value[1] != '\0') return false;
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor += 1) {
    if (*cursor < '0' || *cursor > '9') return false;
  }
  errno = 0;
  char *end = NULL;
  uintmax_t parsed = strtoumax(value, &end, 10);
  if (errno == ERANGE || end == NULL || *end != '\0' || parsed > UINT64_MAX) return false;
  *out = (uint64_t)parsed;
  return true;
}

static bool split_fields(char *line, char **fields, size_t capacity, size_t *count_out) {
  if (capacity == 0U || line == NULL || line[0] == '\0') return false;
  size_t count = 1U;
  fields[0] = line;
  for (char *cursor = line; *cursor != '\0'; cursor += 1) {
    if (*cursor != '\t') continue;
    *cursor = '\0';
    if (count >= capacity) return false;
    fields[count] = cursor + 1;
    count += 1U;
  }
  for (size_t index = 0U; index < count; index += 1U) {
    if (fields[index][0] == '\0') return false;
  }
  *count_out = count;
  return true;
}

static unsigned char hex_nibble(char value, bool *ok) {
  if (value >= '0' && value <= '9') return (unsigned char)(value - '0');
  if (value >= 'a' && value <= 'f') return (unsigned char)(10 + value - 'a');
  *ok = false;
  return 0U;
}

static bool decode_hex(const char *encoded, unsigned char *out, size_t capacity, size_t *length_out) {
  size_t length = strlen(encoded);
  if (length == 0U || (length % 2U) != 0U || (length / 2U) > capacity) return false;
  bool ok = true;
  for (size_t index = 0U; index < length; index += 2U) {
    unsigned char high = hex_nibble(encoded[index], &ok);
    unsigned char low = hex_nibble(encoded[index + 1U], &ok);
    if (!ok) return false;
    out[index / 2U] = (unsigned char)((high << 4U) | low);
  }
  *length_out = length / 2U;
  return true;
}

static bool decode_path_hex(const char *encoded, char *out, size_t capacity) {
  size_t length = 0U;
  if (!decode_hex(encoded, (unsigned char *)out, capacity - 1U, &length) || length == 0U) return false;
  for (size_t index = 0U; index < length; index += 1U) {
    if (out[index] == '\0') return false;
  }
  out[length] = '\0';
  return true;
}

static bool valid_component(const char *component) {
  return component != NULL &&
    component[0] != '\0' &&
    strcmp(component, ".") != 0 &&
    strcmp(component, "..") != 0 &&
    strchr(component, '/') == NULL;
}

static bool count_absolute_components(const char *path, size_t *count_out) {
  if (path == NULL || path[0] != '/' || path[1] == '\0' || strlen(path) > MAX_PATH_BYTES) return false;
  char copy[MAX_PATH_BYTES + 1U];
  memcpy(copy, path + 1, strlen(path));
  size_t count = 0U;
  char *segment = copy;
  while (segment != NULL) {
    char *next = strchr(segment, '/');
    if (next != NULL) *next = '\0';
    if (!valid_component(segment) || count >= MAX_ROOT_COMPONENTS) return false;
    count += 1U;
    segment = next == NULL ? NULL : next + 1;
  }
  *count_out = count;
  return count > 0U;
}

static bool valid_opaque(const char *value) {
  size_t length = value == NULL ? 0U : strlen(value);
  if (length == 0U || length > MAX_OPAQUE_BYTES) return false;
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor += 1) {
    if (!((*cursor >= 'a' && *cursor <= 'z') ||
          (*cursor >= 'A' && *cursor <= 'Z') ||
          (*cursor >= '0' && *cursor <= '9') ||
          *cursor == '_' || *cursor == '-')) {
      return false;
    }
  }
  return true;
}

static bool valid_stage_name(const char *value) {
  static const char prefix[] = "stage-";
  static const char suffix[] = ".wcsb";
  size_t length = value == NULL ? 0U : strlen(value);
  if (length != (sizeof(prefix) - 1U) + 64U + (sizeof(suffix) - 1U) ||
      strncmp(value, prefix, sizeof(prefix) - 1U) != 0 ||
      strcmp(value + length - (sizeof(suffix) - 1U), suffix) != 0) {
    return false;
  }
  for (size_t index = sizeof(prefix) - 1U; index < (sizeof(prefix) - 1U) + 64U; index += 1U) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}

static bool valid_final_name(const char *value) {
  static const char prefix[] = "bundle-";
  static const char suffix[] = ".wcsb";
  size_t length = value == NULL ? 0U : strlen(value);
  if (length != (sizeof(prefix) - 1U) + 64U + (sizeof(suffix) - 1U) ||
      strncmp(value, prefix, sizeof(prefix) - 1U) != 0 ||
      strcmp(value + length - (sizeof(suffix) - 1U), suffix) != 0) return false;
  for (size_t index = sizeof(prefix) - 1U; index < (sizeof(prefix) - 1U) + 64U; index += 1U) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}

static bool valid_digest(const char *value) {
  if (value == NULL || strlen(value) != 71U || strncmp(value, "sha256:", 7U) != 0) return false;
  for (size_t index = 7U; index < 71U; index += 1U) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}

static LineResult read_line(char *buffer, size_t capacity) {
  if (fgets(buffer, (int)capacity, stdin) == NULL) {
    return feof(stdin) ? LINE_EOF : LINE_IO;
  }
  size_t length = strlen(buffer);
  if (length == 0U || buffer[length - 1U] != '\n') return LINE_INVALID;
  buffer[length - 1U] = '\0';
  if (length > 1U && buffer[length - 2U] == '\r') return LINE_INVALID;
  return LINE_OK;
}

static bool trusted_root_ready(void) {
  struct stat value;
  int flags = fcntl(TRUSTED_ROOT_FD, F_GETFL);
  return flags >= 0 &&
    (flags & O_ACCMODE) == O_RDONLY &&
    fstat(TRUSTED_ROOT_FD, &value) == 0 &&
    S_ISDIR(value.st_mode);
}

static bool walk_root(RootBinding *binding, bool capture, int *project_out) {
  int current = fcntl(TRUSTED_ROOT_FD, F_DUPFD_CLOEXEC, 0);
  if (current < 0) return false;
  char copy[MAX_PATH_BYTES + 1U];
  memcpy(copy, binding->path + 1, strlen(binding->path));
  char *segment = copy;
  for (size_t index = 0U; index < binding->component_count; index += 1U) {
    char *next = strchr(segment, '/');
    if (next != NULL) *next = '\0';
    int child = openat(
      current,
      segment,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC
    );
    (void)close(current);
    if (child < 0) return false;
    struct stat value;
    Identity actual;
    if (fstat(child, &value) != 0 || !identity_from_stat(&value, &actual) || !S_ISDIR(value.st_mode)) {
      (void)close(child);
      return false;
    }
    if (capture) {
      binding->components[index] = actual;
    } else if (!same_directory(&actual, &binding->components[index])) {
      (void)close(child);
      return false;
    }
    current = child;
    segment = next == NULL ? NULL : next + 1;
  }
  *project_out = current;
  return true;
}

static bool revalidate_root(RootBinding *binding) {
  int project = -1;
  bool valid = walk_root(binding, false, &project);
  if (project >= 0 && close(project) != 0) valid = false;
  return valid;
}

static bool bind_project(char *line, RootBinding *binding) {
  char *fields[2];
  size_t count = 0U;
  if (!split_fields(line, fields, 2U, &count) || count != 2U || strcmp(fields[0], "P") != 0 ||
      !decode_path_hex(fields[1], binding->path, sizeof(binding->path)) ||
      !count_absolute_components(binding->path, &binding->component_count)) {
    return write_error('P', "PROTOCOL") && false;
  }
  if (!trusted_root_ready()) return write_error('P', "ROOT") && false;
  int project = -1;
  if (!walk_root(binding, true, &project)) return write_error('P', "PATH") && false;
  binding->project_fd = project;
  const Identity *identity = &binding->components[binding->component_count - 1U];
  if (!compute_root_identity_digest(identity, binding->root_identity_digest)) {
    (void)close(project);
    binding->project_fd = -1;
    return write_error('P', "IDENTITY") && false;
  }
  char response[256];
  int length = snprintf(
    response,
    sizeof(response),
    "P\tOK\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\n",
    identity->dev,
    identity->ino,
    identity->uid,
    permission_mode(identity->mode)
  );
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static bool open_private_directory(int parent, const char *name, int *fd_out, Identity *identity_out) {
  int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat value;
  Identity identity;
  int flags = fcntl(fd, F_GETFL);
  bool valid = flags >= 0 &&
    (flags & O_ACCMODE) == O_RDONLY &&
    fstat(fd, &value) == 0 &&
    identity_from_stat(&value, &identity) &&
    S_ISDIR(value.st_mode) &&
    value.st_uid == geteuid() &&
    (value.st_mode & 0777) == 0700;
  if (!valid) {
    (void)close(fd);
    return false;
  }
  *fd_out = fd;
  *identity_out = identity;
  return true;
}

static void close_storage(StorageBinding *storage) {
  if (storage->control_fd >= 0) (void)close(storage->control_fd);
  if (storage->bundles_fd >= 0) (void)close(storage->bundles_fd);
  if (storage->quarantine_fd >= 0) (void)close(storage->quarantine_fd);
  storage->control_fd = -1;
  storage->bundles_fd = -1;
  storage->quarantine_fd = -1;
  storage->ready = false;
}

static bool open_private_tree(const RootBinding *root, StorageBinding *storage) {
  int meta = -1;
  int snapshots = -1;
  int version = -1;
  Identity ignored;
  bool valid = open_private_directory(root->project_fd, ".writcraft", &meta, &ignored) &&
    open_private_directory(meta, "snapshots", &snapshots, &ignored) &&
    open_private_directory(snapshots, "v1", &version, &ignored) &&
    open_private_directory(version, "control", &storage->control_fd, &storage->control_identity) &&
    open_private_directory(version, "bundles", &storage->bundles_fd, &storage->bundles_identity) &&
    open_private_directory(version, "quarantine", &storage->quarantine_fd, &storage->quarantine_identity);
  if (meta >= 0) (void)close(meta);
  if (snapshots >= 0) (void)close(snapshots);
  if (version >= 0) (void)close(version);
  if (!valid) {
    close_storage(storage);
    return false;
  }
  storage->ready = true;
  return true;
}

static bool ensure_private_directory(
  int parent,
  const char *name,
  int *fd_out,
  Identity *identity_out
) {
  bool created = false;
  if (mkdirat(parent, name, 0700) == 0) {
    created = true;
  } else if (errno != EEXIST) {
    return false;
  }
  if (!open_private_directory(parent, name, fd_out, identity_out)) return false;
  if (created && fsync(parent) != 0) {
    (void)close(*fd_out);
    *fd_out = -1;
    return false;
  }
  return true;
}

static bool initialize_private_tree(RootBinding *root, StorageBinding *storage) {
  int meta = -1;
  int snapshots = -1;
  int version = -1;
  Identity ignored;
  bool valid = revalidate_root(root) &&
    ensure_private_directory(root->project_fd, ".writcraft", &meta, &ignored) &&
    ensure_private_directory(meta, "snapshots", &snapshots, &ignored) &&
    ensure_private_directory(snapshots, "v1", &version, &ignored) &&
    ensure_private_directory(
      version, "control", &storage->control_fd, &storage->control_identity
    ) &&
    ensure_private_directory(
      version, "bundles", &storage->bundles_fd, &storage->bundles_identity
    ) &&
    ensure_private_directory(
      version, "quarantine", &storage->quarantine_fd, &storage->quarantine_identity
    ) &&
    fsync(version) == 0 &&
    revalidate_root(root);
  if (meta >= 0) (void)close(meta);
  if (snapshots >= 0) (void)close(snapshots);
  if (version >= 0) (void)close(version);
  if (!valid) {
    close_storage(storage);
    return false;
  }
  storage->ready = true;
  return true;
}

static bool revalidate_storage(const RootBinding *root, const StorageBinding *expected) {
  StorageBinding actual;
  memset(&actual, 0, sizeof(actual));
  actual.control_fd = -1;
  actual.bundles_fd = -1;
  actual.quarantine_fd = -1;
  if (!open_private_tree(root, &actual)) return false;
  bool valid = same_directory(&actual.control_identity, &expected->control_identity) &&
    same_directory(&actual.bundles_identity, &expected->bundles_identity) &&
    same_directory(&actual.quarantine_identity, &expected->quarantine_identity);
  close_storage(&actual);
  return valid;
}

static bool bind_storage(RootBinding *root, StorageBinding *storage, bool initialize) {
  const char command = initialize ? 'I' : 'D';
  if (!revalidate_root(root) ||
      !(initialize ? initialize_private_tree(root, storage) : open_private_tree(root, storage))) {
    return write_error(command, "PRIVATE_PARENT") && false;
  }
  if (!compute_parent_identity_digest(
        "control", root->root_identity_digest, &storage->control_identity,
        storage->control_identity_digest
      ) ||
      !compute_parent_identity_digest(
        "bundles", root->root_identity_digest, &storage->bundles_identity,
        storage->bundles_identity_digest
      ) ||
      !compute_parent_identity_digest(
        "quarantine", root->root_identity_digest, &storage->quarantine_identity,
        storage->quarantine_identity_digest
      )) {
    return write_error(command, "IDENTITY") && false;
  }
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    return write_error(command, "PRIVATE_PARENT") && false;
  }
  char response[512];
  int length = snprintf(
    response,
    sizeof(response),
    "%c\tOK\tcontrol\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX
    "\tbundles\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX
    "\tquarantine\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\n",
    command,
    storage->control_identity.dev,
    storage->control_identity.ino,
    storage->control_identity.uid,
    permission_mode(storage->control_identity.mode),
    storage->bundles_identity.dev,
    storage->bundles_identity.ino,
    storage->bundles_identity.uid,
    permission_mode(storage->bundles_identity.mode),
    storage->quarantine_identity.dev,
    storage->quarantine_identity.ino,
    storage->quarantine_identity.uid,
    permission_mode(storage->quarantine_identity.mode)
  );
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static bool stage_path_matches(const StorageBinding *storage, const Stage *stage, Identity *identity_out) {
  struct stat at_path;
  struct stat held;
  Identity path_identity;
  Identity held_identity;
  if (fstatat(storage->control_fd, stage->basename, &at_path, AT_SYMLINK_NOFOLLOW) != 0 ||
      fstat(stage->fd, &held) != 0 ||
      !identity_from_stat(&at_path, &path_identity) ||
      !identity_from_stat(&held, &held_identity) ||
      !same_regular_identity(&path_identity, &held_identity)) {
    return false;
  }
  if (identity_out != NULL) *identity_out = held_identity;
  return true;
}

static bool create_stage(
  char *line,
  RootBinding *root,
  StorageBinding *storage,
  Stage *stage
) {
  char *fields[5];
  size_t count = 0U;
  uint64_t expected_bytes = 0U;
  if (!split_fields(line, fields, 5U, &count) || count != 5U || strcmp(fields[0], "S") != 0 ||
      !valid_opaque(fields[1]) || !valid_opaque(fields[2]) || !valid_stage_name(fields[3]) ||
      !decimal_uint64(fields[4], &expected_bytes) || expected_bytes > MAX_BUNDLE_BYTES ||
      stage->active) {
    return write_error('S', "PROTOCOL") && false;
  }
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    return write_error('S', "ROOT") && false;
  }
  int fd = openat(
    storage->control_fd,
    fields[3],
    O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC,
    0600
  );
  if (fd < 0) {
    return write_error('S', errno == EEXIST ? "STAGE_EXISTS" : "IO") && false;
  }
  struct stat value;
  Identity identity;
  bool valid = fstat(fd, &value) == 0 &&
    identity_from_stat(&value, &identity) &&
    S_ISREG(value.st_mode) &&
    value.st_uid == geteuid() &&
    (value.st_mode & 0777) == 0600 &&
    value.st_nlink == 1 &&
    value.st_size == 0;
  if (!valid) {
    (void)close(fd);
    return write_error('S', "IDENTITY") && false;
  }
  memcpy(stage->transaction_id, fields[1], strlen(fields[1]) + 1U);
  memcpy(stage->snapshot_id, fields[2], strlen(fields[2]) + 1U);
  memcpy(stage->basename, fields[3], strlen(fields[3]) + 1U);
  stage->expected_bytes = expected_bytes;
  stage->initial_identity = identity;
  stage->fd = fd;
  stage->active = true;
  stage->finalized = false;
  StageReservation reservation;
  memset(&reservation, 0, sizeof(reservation));
  memcpy(reservation.transaction_id, stage->transaction_id, strlen(stage->transaction_id) + 1U);
  memcpy(reservation.snapshot_id, stage->snapshot_id, strlen(stage->snapshot_id) + 1U);
  memcpy(reservation.stage_basename, stage->basename, strlen(stage->basename) + 1U);
  reservation.expected_bytes = expected_bytes;
  reservation.identity = identity;
  char reservation_json[4096];
  if (!reservation_name(stage->transaction_id, stage->reservation_name) ||
      !make_stage_reservation_json(
        &reservation, reservation_json, sizeof(reservation_json), reservation.record_digest
      )) {
    bool stage_removed = cleanup_live_stage(storage, stage);
    return write_error('S', stage_removed ? "IO" : "UNKNOWN") && false;
  }
  int reservation_fd = -1;
  bool reservation_created = create_control_record(
    storage, stage->reservation_name, reservation_json, &reservation_fd
  );
  bool reservation_durable = reservation_created && fsync(storage->control_fd) == 0;
  if (!reservation_durable) {
    bool stage_removed = cleanup_live_stage(storage, stage);
    bool reservation_present = reservation_fd >= 0;
    bool reservation_removed = !reservation_present;
    if (reservation_present && stage_removed) {
      reservation_removed = remove_owned_control(storage, stage->reservation_name, reservation_fd);
    }
    if (reservation_fd >= 0) (void)close(reservation_fd);
    return write_error('S', stage_removed && reservation_removed ? "IO" : "UNKNOWN") && false;
  }
  stage->reservation_fd = reservation_fd;
#ifdef WRITCRAFT_TEST_CRASH_AFTER_STAGE_RESERVATION
  _exit(84);
#endif
  char response[768];
  int length = snprintf(
    response,
    sizeof(response),
    "S\tOK\t%s\t%s\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX
    "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\n",
    stage->transaction_id,
    stage->snapshot_id,
    identity.dev,
    identity.ino,
    identity.uid,
    permission_mode(identity.mode),
    identity.nlink,
    identity.size
  );
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static bool full_write(int fd, const unsigned char *bytes, size_t length) {
  size_t offset = 0U;
  while (offset < length) {
    ssize_t written = write(fd, bytes + offset, length - offset);
    if (written <= 0 || (size_t)written > length - offset) return false;
    offset += (size_t)written;
  }
  return true;
}

static bool write_stage_chunk(char *line, StorageBinding *storage, Stage *stage) {
  char *fields[3];
  size_t count = 0U;
  if (!split_fields(line, fields, 3U, &count) || count != 3U || strcmp(fields[0], "W") != 0 ||
      !stage->active || stage->finalized || strcmp(fields[1], stage->transaction_id) != 0) {
    return write_error('W', "PROTOCOL");
  }
  size_t encoded_length = strlen(fields[2]);
  if (encoded_length == 0U || encoded_length > MAX_CHUNK_BYTES * 2U) {
    return write_error('W', "BUDGET");
  }
  unsigned char *bytes = malloc(MAX_CHUNK_BYTES);
  if (bytes == NULL) return write_error('W', "IO");
  size_t length = 0U;
  bool decoded = decode_hex(fields[2], bytes, MAX_CHUNK_BYTES, &length);
  Identity before;
  bool valid = decoded &&
    stage_path_matches(storage, stage, &before) &&
    before.size <= stage->expected_bytes &&
    (uint64_t)length <= stage->expected_bytes - before.size;
  if (!valid) {
    free(bytes);
    return write_error('W', decoded ? "IDENTITY" : "PROTOCOL");
  }
#ifdef WRITCRAFT_TEST_PARTIAL_WRITE_FAIL
  size_t partial = length > 1U ? length / 2U : length;
  bool wrote = partial > 0U && full_write(stage->fd, bytes, partial);
  free(bytes);
  if (wrote) (void)fsync(stage->fd);
  return write_error('W', "IO");
#else
  bool wrote = full_write(stage->fd, bytes, length);
  free(bytes);
  if (!wrote) return write_error('W', "IO");
  Identity after;
  if (!stage_path_matches(storage, stage, &after) || after.size != before.size + length) {
    return write_error('W', "IDENTITY");
  }
  char response[384];
  int response_length = snprintf(
    response,
    sizeof(response),
    "W\tOK\t%s\t%" PRIuMAX "\n",
    stage->transaction_id,
    after.size
  );
  return response_length > 0 && (size_t)response_length < sizeof(response) && write_line(response);
#endif
}

static bool hash_fd_stable(int fd, Identity *identity_out, unsigned char digest[CC_SHA256_DIGEST_LENGTH]) {
  struct stat before_stat;
  Identity before;
  if (fstat(fd, &before_stat) != 0 || !identity_from_stat(&before_stat, &before) ||
      !S_ISREG(before_stat.st_mode) || before.size > MAX_BUNDLE_BYTES) return false;
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  unsigned char bytes[HASH_CHUNK_BYTES];
  uintmax_t offset = 0U;
  while (offset < before.size) {
    size_t requested = before.size - offset > HASH_CHUNK_BYTES
      ? HASH_CHUNK_BYTES
      : (size_t)(before.size - offset);
    ssize_t received = pread(fd, bytes, requested, (off_t)offset);
    if (received <= 0 || (size_t)received > requested) return false;
    CC_SHA256_Update(&context, bytes, (CC_LONG)received);
    offset += (uintmax_t)received;
  }
  struct stat after_stat;
  Identity after;
  if (fstat(fd, &after_stat) != 0 || !identity_from_stat(&after_stat, &after) ||
      !same_regular_identity(&before, &after)) return false;
  CC_SHA256_Final(digest, &context);
  *identity_out = after;
  return true;
}

static bool pread_exact(int fd, void *buffer, size_t length, uint64_t offset) {
  size_t received_total = 0U;
  while (received_total < length) {
    if (offset + received_total > (uint64_t)INT64_MAX) return false;
    ssize_t received = pread(
      fd,
      (unsigned char *)buffer + received_total,
      length - received_total,
      (off_t)(offset + received_total)
    );
    if (received <= 0 || (size_t)received > length - received_total) return false;
    received_total += (size_t)received;
  }
  return true;
}

static uint32_t uint32_be(const unsigned char bytes[4]) {
  return ((uint32_t)bytes[0] << 24U) |
    ((uint32_t)bytes[1] << 16U) |
    ((uint32_t)bytes[2] << 8U) |
    (uint32_t)bytes[3];
}

static uint64_t uint64_be(const unsigned char bytes[8]) {
  uint64_t result = 0U;
  for (size_t index = 0U; index < 8U; index += 1U) result = (result << 8U) | bytes[index];
  return result;
}

static bool hash_fd_range(int fd, uint64_t offset, uint64_t length, unsigned char digest[CC_SHA256_DIGEST_LENGTH]) {
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  unsigned char bytes[HASH_CHUNK_BYTES];
  uint64_t consumed = 0U;
  while (consumed < length) {
    size_t requested = length - consumed > HASH_CHUNK_BYTES
      ? HASH_CHUNK_BYTES
      : (size_t)(length - consumed);
    if (!pread_exact(fd, bytes, requested, offset + consumed)) return false;
    CC_SHA256_Update(&context, bytes, (CC_LONG)requested);
    consumed += requested;
  }
  CC_SHA256_Final(digest, &context);
  return true;
}

static bool strict_utf8(const unsigned char *bytes, size_t length) {
  size_t index = 0U;
  while (index < length) {
    unsigned char first = bytes[index++];
    if (first <= 0x7fU) continue;
    uint32_t scalar = 0U;
    size_t remaining = 0U;
    uint32_t minimum = 0U;
    if (first >= 0xc2U && first <= 0xdfU) {
      scalar = first & 0x1fU; remaining = 1U; minimum = 0x80U;
    } else if (first >= 0xe0U && first <= 0xefU) {
      scalar = first & 0x0fU; remaining = 2U; minimum = 0x800U;
    } else if (first >= 0xf0U && first <= 0xf4U) {
      scalar = first & 0x07U; remaining = 3U; minimum = 0x10000U;
    } else return false;
    if (index + remaining > length) return false;
    for (size_t part = 0U; part < remaining; part += 1U) {
      unsigned char next = bytes[index++];
      if ((next & 0xc0U) != 0x80U) return false;
      scalar = (scalar << 6U) | (next & 0x3fU);
    }
    if (scalar < minimum || scalar > 0x10ffffU || (scalar >= 0xd800U && scalar <= 0xdfffU)) return false;
  }
  return true;
}

static bool project_instance_id(const char *value) {
  if (value == NULL || strlen(value) != 33U || strncmp(value, "instance_", 9U) != 0) return false;
  for (size_t index = 9U; index < 33U; index += 1U) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}

static bool public_path_bytes(const char *path) {
  size_t length = path == NULL ? 0U : strlen(path);
  if (length == 0U || length > MAX_PATH_BYTES || path[0] == '/' ||
      strchr(path, '\\') != NULL || !strict_utf8((const unsigned char *)path, length)) return false;
  const char *segment = path;
  while (*segment != '\0') {
    const char *slash = strchr(segment, '/');
    size_t segment_length = slash == NULL ? strlen(segment) : (size_t)(slash - segment);
    if (segment_length == 0U || segment[0] == '.') return false;
    for (size_t index = 0U; index < segment_length; index += 1U) {
      if ((unsigned char)segment[index] < 0x20U) return false;
    }
    segment = slash == NULL ? segment + segment_length : slash + 1U;
  }
  return true;
}

static bool suffix_case(const char *value, const char *suffix) {
  size_t value_length = strlen(value);
  size_t suffix_length = strlen(suffix);
  return value_length >= suffix_length &&
    strcasecmp(value + value_length - suffix_length, suffix) == 0;
}

static bool markdown_path(const char *path) {
  return suffix_case(path, ".md") || suffix_case(path, ".markdown");
}

static bool image_path(const char *path) {
  return suffix_case(path, ".png") || suffix_case(path, ".jpg") ||
    suffix_case(path, ".jpeg") || suffix_case(path, ".gif") || suffix_case(path, ".webp");
}

static void opaque_capture_id(
  const char *prefix,
  const char *transaction_id,
  const char *snapshot_id,
  const char *path,
  char out[MAX_OPAQUE_BYTES + 1U]
) {
  CC_SHA256_CTX context;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  unsigned char zero = 0U;
  CC_SHA256_Init(&context);
  CC_SHA256_Update(&context, prefix, (CC_LONG)strlen(prefix));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, transaction_id, (CC_LONG)strlen(transaction_id));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, snapshot_id, (CC_LONG)strlen(snapshot_id));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, path, (CC_LONG)strlen(path));
  CC_SHA256_Final(digest, &context);
  size_t prefix_length = strlen(prefix);
  memcpy(out, prefix, prefix_length);
  digest_hex(digest, out + prefix_length);
}

static bool compute_ancestor_identity_digest(
  const ScanAncestor *ancestors,
  size_t depth,
  char out[DIGEST_TEXT_BYTES + 1U]
) {
  size_t capacity = 128U + (depth * 384U);
  char *canonical = malloc(capacity);
  if (canonical == NULL) return false;
  size_t used = 0U;
  int length = snprintf(canonical, capacity, "{\"components\":[");
  bool valid = length > 0 && (size_t)length < capacity;
  if (valid) used = (size_t)length;
  for (size_t index = 0U; valid && index < depth; index += 1U) {
    char name_digest[DIGEST_TEXT_BYTES + 1U];
    sha256_prefixed(
      (const unsigned char *)ancestors[index].name,
      strlen(ancestors[index].name),
      name_digest
    );
    length = snprintf(
      canonical + used,
      capacity - used,
      "%s{\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX
      "\",\"mode\":%" PRIuMAX ",\"nameSha256\":\"%s\",\"uid\":%" PRIuMAX "}",
      index == 0U ? "" : ",",
      ancestors[index].identity.dev,
      ancestors[index].identity.ino,
      permission_mode(ancestors[index].identity.mode),
      name_digest,
      ancestors[index].identity.uid
    );
    valid = length > 0 && (size_t)length < capacity - used;
    if (valid) used += (size_t)length;
  }
  if (valid) {
    length = snprintf(
      canonical + used,
      capacity - used,
      "],\"schema\":\"writcraft.ancestor-identity/v1\"}"
    );
    valid = length > 0 && (size_t)length < capacity - used;
  }
  if (valid) valid = digest_domain("writcraft.ancestor-identity/v1", canonical, out);
  free(canonical);
  return valid;
}

static bool compute_source_object_identity_digest(
  const Identity *identity,
  const char *content_digest,
  char out[DIGEST_TEXT_BYTES + 1U]
) {
  if (identity->mtime_ns < 0 || identity->ctime_ns < 0) return false;
  char canonical[1024];
  int length = snprintf(
    canonical,
    sizeof(canonical),
    "{\"contentSha256\":\"%s\",\"ctimeNs\":\"%" PRIuMAX
    "\",\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX
    "\",\"mode\":%" PRIuMAX ",\"mtimeNs\":\"%" PRIuMAX
    "\",\"nlink\":%" PRIuMAX ",\"schema\":\"writcraft.object-identity/v1\""
    ",\"size\":\"%" PRIuMAX "\",\"uid\":%" PRIuMAX "}",
    content_digest,
    (uintmax_t)identity->ctime_ns,
    identity->dev,
    identity->ino,
    permission_mode(identity->mode),
    (uintmax_t)identity->mtime_ns,
    identity->nlink,
    identity->size,
    identity->uid
  );
  return length > 0 && (size_t)length < sizeof(canonical) &&
    digest_domain("writcraft.object-identity/v1", canonical, out);
}

static bool revalidate_scan_ancestors(
  const RootBinding *root,
  const ScanAncestor *ancestors,
  size_t depth
) {
  int parent_fd = root->project_fd;
  for (size_t index = 0U; index < depth; index += 1U) {
    struct stat held;
    struct stat at_path;
    Identity held_identity;
    Identity path_identity;
    if (fstat(ancestors[index].fd, &held) != 0 ||
        fstatat(parent_fd, ancestors[index].name, &at_path, AT_SYMLINK_NOFOLLOW) != 0 ||
        !identity_from_stat(&held, &held_identity) || !identity_from_stat(&at_path, &path_identity) ||
        !same_directory(&ancestors[index].identity, &held_identity) ||
        !same_directory(&ancestors[index].identity, &path_identity)) return false;
    parent_fd = ancestors[index].fd;
  }
  return true;
}

static int compare_capture_entry(const void *left, const void *right) {
  return strcmp(((const CaptureEntry *)left)->path, ((const CaptureEntry *)right)->path);
}

static void free_sealed_capture(SealedCapture *capture) {
  if (capture->entries != NULL) {
    for (size_t index = 0U; index < capture->entry_count; index += 1U) {
      free(capture->entries[index].bytes);
    }
    free(capture->entries);
  }
  free(capture->token_pass_bytes);
  free(capture->image_references);
  memset(capture, 0, sizeof(*capture));
}

static bool append_capture_entry(SealedCapture *capture, const CaptureEntry *entry) {
  if (capture->entry_count >= MAX_SCAN_ENTRIES) return false;
  CaptureEntry *resized = realloc(
    capture->entries, (capture->entry_count + 1U) * sizeof(*capture->entries)
  );
  if (resized == NULL) return false;
  capture->entries = resized;
  capture->entries[capture->entry_count] = *entry;
  capture->entry_count += 1U;
  return true;
}

static bool read_markdown_source(
  RootBinding *root,
  int parent_fd,
  const char *leaf,
  const char *path,
  const ScanAncestor *ancestors,
  size_t depth,
  SealedCapture *capture,
  const Identity *discovered,
  const char **error_out
) {
  if (discovered->nlink != 1U || discovered->size > (4U * 1024U * 1024U)) {
    *error_out = discovered->nlink != 1U ? "SOURCE_TYPE" : "SOURCE_BUDGET";
    return false;
  }
  if (capture->markdown_count >= 300U ||
      capture->markdown_bytes > (64U * 1024U * 1024U) - discovered->size) {
    *error_out = "SOURCE_BUDGET";
    return false;
  }
  int fd = openat(parent_fd, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) {
    *error_out = "SOURCE_IO";
    return false;
  }
  unsigned char *bytes = malloc(discovered->size == 0U ? 1U : (size_t)discovered->size);
  struct stat held_stat;
  struct stat path_stat;
  Identity held;
  Identity at_path;
  bool decoded = false;
  bool valid = bytes != NULL && fstat(fd, &held_stat) == 0 &&
    fstatat(parent_fd, leaf, &path_stat, AT_SYMLINK_NOFOLLOW) == 0 &&
    identity_from_stat(&held_stat, &held) && identity_from_stat(&path_stat, &at_path) &&
    same_regular_identity(discovered, &held) && same_regular_identity(discovered, &at_path) &&
    (held.size == 0U || pread_exact(fd, bytes, (size_t)held.size, 0U));
  if (valid) decoded = strict_utf8(bytes, (size_t)held.size);
  valid = valid && decoded && revalidate_scan_ancestors(root, ancestors, depth);
  struct stat after_stat;
  struct stat after_path_stat;
  Identity after;
  Identity after_path;
  valid = valid && fstat(fd, &after_stat) == 0 &&
    fstatat(parent_fd, leaf, &after_path_stat, AT_SYMLINK_NOFOLLOW) == 0 &&
    identity_from_stat(&after_stat, &after) && identity_from_stat(&after_path_stat, &after_path) &&
    same_regular_identity(discovered, &after) && same_regular_identity(discovered, &after_path);
  (void)close(fd);
  if (!valid) {
    free(bytes);
    *error_out = decoded ? "SOURCE_STALE" : "SOURCE_ENCODING";
    return false;
  }
  CaptureEntry entry;
  memset(&entry, 0, sizeof(entry));
  entry.kind = CAPTURE_MARKDOWN;
  memcpy(entry.path, path, strlen(path) + 1U);
  entry.byte_length = held.size;
  entry.identity = held;
  entry.bytes = bytes;
  sha256_prefixed(bytes, (size_t)held.size, entry.content_sha256);
  opaque_capture_id("file_", capture->transaction_id, capture->snapshot_id, path, entry.opaque_id);
  opaque_capture_id(
    "candidate_", capture->transaction_id, capture->snapshot_id, path, entry.candidate_id
  );
  if (!compute_ancestor_identity_digest(
        ancestors, depth, entry.ancestor_identity_digest
      ) || !compute_source_object_identity_digest(
        &held, entry.content_sha256, entry.source_object_identity_digest
      ) || !append_capture_entry(capture, &entry)) {
    free(bytes);
    *error_out = "SOURCE_LIMIT";
    return false;
  }
  capture->markdown_count += 1U;
  capture->markdown_bytes += held.size;
  return true;
}

static int compare_name_pointer(const void *left, const void *right) {
  return strcmp(*(const char * const *)left, *(const char * const *)right);
}

static bool scan_capture_directory(
  RootBinding *root,
  int directory_fd,
  const char *prefix,
  ScanAncestor ancestors[MAX_ROOT_COMPONENTS],
  size_t depth,
  SealedCapture *capture,
  const char **error_out
) {
  // A dup shares the directory stream offset with the held fd and would make
  // the mandatory second scan observe EOF. Open "." for an independent open
  // file description, then bind it to the held directory identity.
  int duplicate = openat(
    directory_fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (duplicate < 0) {
    *error_out = "SOURCE_IO";
    return false;
  }
  struct stat held_directory_stat;
  struct stat duplicate_stat;
  Identity held_directory_identity;
  Identity duplicate_identity;
  if (fstat(directory_fd, &held_directory_stat) != 0 || fstat(duplicate, &duplicate_stat) != 0 ||
      !identity_from_stat(&held_directory_stat, &held_directory_identity) ||
      !identity_from_stat(&duplicate_stat, &duplicate_identity) ||
      !same_directory(&held_directory_identity, &duplicate_identity)) {
    (void)close(duplicate);
    *error_out = "SOURCE_STALE";
    return false;
  }
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    (void)close(duplicate);
    *error_out = "SOURCE_IO";
    return false;
  }
  char **names = NULL;
  size_t name_count = 0U;
  struct dirent *item = NULL;
  bool listed = true;
  while ((item = readdir(directory)) != NULL) {
    if (strcmp(item->d_name, ".") == 0 || strcmp(item->d_name, "..") == 0) continue;
    capture->scanned_entries += 1U;
    if (capture->scanned_entries > MAX_SCAN_ENTRIES || strlen(item->d_name) > 255U) {
      listed = false;
      *error_out = "SOURCE_LIMIT";
      break;
    }
    char **resized = realloc(names, (name_count + 1U) * sizeof(*names));
    if (resized == NULL) {
      listed = false;
      *error_out = "SOURCE_LIMIT";
      break;
    }
    names = resized;
    names[name_count] = strdup(item->d_name);
    if (names[name_count] == NULL) {
      listed = false;
      *error_out = "SOURCE_LIMIT";
      break;
    }
    name_count += 1U;
  }
  (void)closedir(directory);
  if (listed) qsort(names, name_count, sizeof(*names), compare_name_pointer);

  for (size_t index = 0U; listed && index < name_count; index += 1U) {
    const char *name = names[index];
    if (name[0] == '.' || strcmp(name, "node_modules") == 0) continue;
    size_t prefix_length = strlen(prefix);
    size_t name_length = strlen(name);
    size_t path_length = prefix_length + (prefix_length == 0U ? 0U : 1U) + name_length;
    if (path_length == 0U || path_length > MAX_PATH_BYTES) {
      listed = false;
      *error_out = "SOURCE_PATH";
      break;
    }
    char path[MAX_PATH_BYTES + 1U];
    int path_written = snprintf(
      path, sizeof(path), "%s%s%s", prefix, prefix_length == 0U ? "" : "/", name
    );
    if (path_written <= 0 || (size_t)path_written != path_length || !public_path_bytes(path)) {
      bool relevant = markdown_path(name) || image_path(name);
      if (relevant) {
        listed = false;
        *error_out = "SOURCE_PATH";
      }
      continue;
    }
    struct stat discovered_stat;
    Identity discovered;
    if (fstatat(directory_fd, name, &discovered_stat, AT_SYMLINK_NOFOLLOW) != 0 ||
        !identity_from_stat(&discovered_stat, &discovered)) {
      listed = false;
      *error_out = "SOURCE_IO";
      break;
    }
    if (S_ISDIR(discovered_stat.st_mode)) {
      if (depth >= MAX_ROOT_COMPONENTS) {
        listed = false;
        *error_out = "SOURCE_LIMIT";
        break;
      }
      int child_fd = openat(
        directory_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
      );
      struct stat child_stat;
      Identity child_identity;
      bool child_valid = child_fd >= 0 && fstat(child_fd, &child_stat) == 0 &&
        identity_from_stat(&child_stat, &child_identity) &&
        same_directory(&discovered, &child_identity);
      if (!child_valid) {
        if (child_fd >= 0) (void)close(child_fd);
        listed = false;
        *error_out = "SOURCE_STALE";
        break;
      }
      memset(&ancestors[depth], 0, sizeof(ancestors[depth]));
      memcpy(ancestors[depth].name, name, name_length + 1U);
      ancestors[depth].identity = child_identity;
      ancestors[depth].fd = child_fd;
      listed = scan_capture_directory(
        root, child_fd, path, ancestors, depth + 1U, capture, error_out
      );
      bool still_bound = revalidate_scan_ancestors(root, ancestors, depth + 1U);
      (void)close(child_fd);
      ancestors[depth].fd = -1;
      if (!listed || !still_bound) {
        if (listed) *error_out = "SOURCE_STALE";
        listed = false;
        break;
      }
      continue;
    }
    bool is_markdown = markdown_path(path);
    bool is_image = image_path(path);
    if (!S_ISREG(discovered_stat.st_mode)) {
      if (is_markdown) {
        listed = false;
        *error_out = "SOURCE_TYPE";
      }
      continue;
    }
    if (is_markdown) {
      listed = read_markdown_source(
        root,
        directory_fd,
        name,
        path,
        ancestors,
        depth,
        capture,
        &discovered,
        error_out
      );
    } else if (is_image) {
      // Image bytes are not scanned speculatively. The exact marked token pass
      // selects relative hrefs after this sealed Markdown capture; native then
      // resolves and reads only those referenced images.
      continue;
    }
  }
  for (size_t index = 0U; index < name_count; index += 1U) free(names[index]);
  free(names);
  return listed;
}

static bool append_text(char *buffer, size_t capacity, size_t *used, const char *format, ...) {
  if (*used >= capacity) return false;
  va_list arguments;
  va_start(arguments, format);
  int length = vsnprintf(buffer + *used, capacity - *used, format, arguments);
  va_end(arguments);
  if (length < 0 || (size_t)length >= capacity - *used) return false;
  *used += (size_t)length;
  return true;
}

static bool seal_capture_digest(const RootBinding *root, SealedCapture *capture) {
  size_t capacity = 4096U + (capture->entry_count * 1024U);
  char *canonical = malloc(capacity);
  if (canonical == NULL) return false;
  size_t used = 0U;
  bool valid = append_text(canonical, capacity, &used, "{\"candidates\":[");
  size_t candidate_index = 0U;
  for (size_t index = 0U; valid && index < capture->entry_count; index += 1U) {
    const CaptureEntry *entry = &capture->entries[index];
    if (entry->kind != CAPTURE_MARKDOWN) continue;
    valid = append_text(
      canonical,
      capacity,
      &used,
      "%s{\"ancestorIdentityDigest\":\"%s\",\"byteLength\":%" PRIu64
      ",\"candidateId\":\"%s\",\"fileId\":\"%s\",\"revision\":\"%s\""
      ",\"sha256\":\"%s\",\"sourceObjectIdentityDigest\":\"%s\"}",
      candidate_index == 0U ? "" : ",",
      entry->ancestor_identity_digest,
      entry->byte_length,
      entry->candidate_id,
      entry->opaque_id,
      entry->content_sha256 + 7U,
      entry->content_sha256,
      entry->source_object_identity_digest
    );
    candidate_index += 1U;
  }
  valid = valid && append_text(
    canonical,
    capacity,
    &used,
    "],\"creationMutationGeneration\":%" PRIu64 ",\"ownerGeneration\":%" PRIu64
    ",\"projectInstanceId\":\"%s\",\"rootIdentityDigest\":\"%s\""
    ",\"schema\":\"writcraft.snapshot-capture-identity/v1\""
    ",\"snapshotId\":\"%s\",\"transactionId\":\"%s\"}",
    capture->mutation_generation,
    capture->owner_generation,
    capture->project_instance_id,
    root->root_identity_digest,
    capture->snapshot_id,
    capture->transaction_id
  );
  if (valid) valid = digest_domain(
    "writcraft.snapshot-capture-identity/v1", canonical, capture->capture_digest
  );
  if (valid) {
    memcpy(capture->capture_id, "capture_", 8U);
    memcpy(capture->capture_id + 8U, capture->capture_digest + 7U, 65U);
  }
  free(canonical);
  return valid;
}

static bool write_hex_field(const unsigned char *bytes, size_t length, char *out) {
  static const char alphabet[] = "0123456789abcdef";
  for (size_t index = 0U; index < length; index += 1U) {
    out[index * 2U] = alphabet[bytes[index] >> 4U];
    out[(index * 2U) + 1U] = alphabet[bytes[index] & 0x0fU];
  }
  out[length * 2U] = '\0';
  return true;
}

static bool emit_sealed_capture(const SealedCapture *capture) {
  for (size_t index = 0U; index < capture->entry_count; index += 1U) {
    const CaptureEntry *entry = &capture->entries[index];
    char metadata[768];
    int metadata_length = 0;
    if (entry->kind == CAPTURE_MARKDOWN) {
      metadata_length = snprintf(
        metadata,
        sizeof(metadata),
        "G\tMARKDOWN\t%s\t%s\t%s\t%" PRIu64 "\t%s\t%s\n",
        capture->capture_id,
        entry->candidate_id,
        entry->opaque_id,
        entry->byte_length,
        entry->content_sha256,
        entry->content_sha256 + 7U
      );
    }
    if (metadata_length <= 0 || (size_t)metadata_length >= sizeof(metadata) || !write_line(metadata)) {
      return false;
    }
    if (entry->kind != CAPTURE_MARKDOWN) continue;
    for (uint64_t offset = 0U; offset < entry->byte_length;) {
      size_t chunk_length = entry->byte_length - offset > MAX_CHUNK_BYTES
        ? MAX_CHUNK_BYTES
        : (size_t)(entry->byte_length - offset);
      char *chunk_hex = malloc((chunk_length * 2U) + 1U);
      if (chunk_hex == NULL) return false;
      (void)write_hex_field(entry->bytes + offset, chunk_length, chunk_hex);
      char *line = malloc((chunk_length * 2U) + 384U);
      if (line == NULL) {
        free(chunk_hex);
        return false;
      }
      int length = snprintf(
        line,
        (chunk_length * 2U) + 384U,
        "G\tBYTES\t%s\t%s\t%" PRIu64 "\t%s\n",
        capture->capture_id,
        entry->candidate_id,
        offset,
        chunk_hex
      );
      free(chunk_hex);
      bool written = length > 0 && (size_t)length < (chunk_length * 2U) + 384U && write_line(line);
      free(line);
      if (!written) return false;
      offset += chunk_length;
    }
  }
  char terminal[768];
  int length = snprintf(
    terminal,
    sizeof(terminal),
    "G\tOK\t%s\t%s\t%s\t%zu\t%" PRIu64 "\n",
    capture->transaction_id,
    capture->capture_id,
    capture->capture_digest,
    capture->markdown_count,
    capture->markdown_bytes
  );
  return length > 0 && (size_t)length < sizeof(terminal) && write_line(terminal);
}

static bool begin_sealed_capture(
  char *line,
  RootBinding *root,
  StorageBinding *storage,
  Stage *stage,
  SealedCapture *capture
) {
  char *fields[7];
  size_t count = 0U;
  uint64_t owner_generation = 0U;
  uint64_t mutation_generation = 0U;
  if (!split_fields(line, fields, 7U, &count) || count != 7U || strcmp(fields[0], "G") != 0 ||
      !valid_opaque(fields[1]) || !project_instance_id(fields[2]) || !valid_opaque(fields[3]) ||
      !decimal_uint64(fields[4], &owner_generation) || owner_generation > MAX_SAFE_INTEGER ||
      !decimal_uint64(fields[5], &mutation_generation) || mutation_generation > MAX_SAFE_INTEGER ||
      !safe_timestamp(fields[6]) || stage->active || capture->active) {
    return write_error('G', "PROTOCOL") && false;
  }
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    return write_error('G', "ROOT") && false;
  }
  memset(capture, 0, sizeof(*capture));
  memcpy(capture->transaction_id, fields[1], strlen(fields[1]) + 1U);
  memcpy(capture->project_instance_id, fields[2], strlen(fields[2]) + 1U);
  memcpy(capture->snapshot_id, fields[3], strlen(fields[3]) + 1U);
  capture->owner_generation = owner_generation;
  capture->mutation_generation = mutation_generation;
  memcpy(capture->created_at, fields[6], strlen(fields[6]) + 1U);
  ScanAncestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  const char *error = "SOURCE_IO";
  bool scanned = scan_capture_directory(
    root, root->project_fd, "", ancestors, 0U, capture, &error
  );
  if (scanned) qsort(
    capture->entries, capture->entry_count, sizeof(*capture->entries), compare_capture_entry
  );
  scanned = scanned && revalidate_root(root) && revalidate_storage(root, storage) &&
    seal_capture_digest(root, capture);
  if (!scanned) {
    free_sealed_capture(capture);
    return write_error('G', error) && false;
  }
  capture->active = true;
  if (!emit_sealed_capture(capture)) {
    free_sealed_capture(capture);
    return false;
  }
  return true;
}

typedef struct {
  const char *cursor;
  const char *end;
} CanonicalJsonInput;

static bool json_literal(CanonicalJsonInput *input, const char *literal) {
  size_t length = strlen(literal);
  if ((size_t)(input->end - input->cursor) < length ||
      memcmp(input->cursor, literal, length) != 0) return false;
  input->cursor += length;
  return true;
}

static bool json_ascii_string(
  CanonicalJsonInput *input,
  char *out,
  size_t capacity,
  bool allow_empty
) {
  if (!json_literal(input, "\"")) return false;
  size_t length = 0U;
  while (input->cursor < input->end && *input->cursor != '"') {
    unsigned char value = (unsigned char)*input->cursor;
    if (value < 0x20U || value > 0x7eU || value == '\\' || length + 1U >= capacity) return false;
    out[length++] = (char)value;
    input->cursor += 1U;
  }
  if (!json_literal(input, "\"") || (!allow_empty && length == 0U)) return false;
  out[length] = '\0';
  return true;
}

static bool json_uint64(CanonicalJsonInput *input, uint64_t *out) {
  const char *start = input->cursor;
  if (start >= input->end || *start < '0' || *start > '9') return false;
  while (input->cursor < input->end && *input->cursor >= '0' && *input->cursor <= '9') {
    input->cursor += 1U;
  }
  size_t length = (size_t)(input->cursor - start);
  if (length == 0U || length > 20U || (length > 1U && start[0] == '0')) return false;
  char decimal[32];
  memcpy(decimal, start, length);
  decimal[length] = '\0';
  return decimal_uint64(decimal, out) && *out <= MAX_SAFE_INTEGER;
}

static int base64_sextet(unsigned char value) {
  if (value >= 'A' && value <= 'Z') return value - 'A';
  if (value >= 'a' && value <= 'z') return 26 + value - 'a';
  if (value >= '0' && value <= '9') return 52 + value - '0';
  if (value == '+') return 62;
  if (value == '/') return 63;
  return -1;
}

static bool decode_canonical_base64(
  const char *encoded,
  unsigned char *out,
  size_t capacity,
  size_t *length_out
) {
  size_t length = strlen(encoded);
  if (length == 0U || length % 4U != 0U) return false;
  size_t padding = encoded[length - 1U] == '=' ? 1U : 0U;
  if (padding == 1U && encoded[length - 2U] == '=') padding = 2U;
  size_t decoded_length = (length / 4U) * 3U - padding;
  if (decoded_length == 0U || decoded_length > capacity) return false;
  size_t output = 0U;
  for (size_t index = 0U; index < length; index += 4U) {
    bool last = index + 4U == length;
    int a = base64_sextet((unsigned char)encoded[index]);
    int b = base64_sextet((unsigned char)encoded[index + 1U]);
    int c = encoded[index + 2U] == '=' ? 0 : base64_sextet((unsigned char)encoded[index + 2U]);
    int d = encoded[index + 3U] == '=' ? 0 : base64_sextet((unsigned char)encoded[index + 3U]);
    if (a < 0 || b < 0 || c < 0 || d < 0 ||
        (!last && (encoded[index + 2U] == '=' || encoded[index + 3U] == '=')) ||
        (encoded[index + 2U] == '=' && encoded[index + 3U] != '=') ||
        (last && padding == 2U && (b & 0x0f) != 0) ||
        (last && padding == 1U && (c & 0x03) != 0)) return false;
    uint32_t bits = ((uint32_t)a << 18U) | ((uint32_t)b << 12U) |
      ((uint32_t)c << 6U) | (uint32_t)d;
    if (output < decoded_length) out[output++] = (unsigned char)(bits >> 16U);
    if (output < decoded_length) out[output++] = (unsigned char)(bits >> 8U);
    if (output < decoded_length) out[output++] = (unsigned char)bits;
  }
  *length_out = decoded_length;
  return output == decoded_length;
}

static bool remote_or_absolute_href(const char *href) {
  if (href[0] == '/' || (href[0] == '/' && href[1] == '/')) return true;
  if (!((href[0] >= 'A' && href[0] <= 'Z') || (href[0] >= 'a' && href[0] <= 'z'))) return false;
  for (size_t index = 1U; href[index] != '\0'; index += 1U) {
    if (href[index] == ':') return true;
    if (!((href[index] >= 'A' && href[index] <= 'Z') ||
          (href[index] >= 'a' && href[index] <= 'z') ||
          (href[index] >= '0' && href[index] <= '9') || href[index] == '+' ||
          href[index] == '.' || href[index] == '-')) return false;
  }
  return false;
}

typedef enum {
  HREF_INVALID = 0,
  HREF_EXCLUDED = 1,
  HREF_ELIGIBLE = 2,
} ImageHrefStatus;

static ImageHrefStatus decode_image_href(
  const char *encoded_base64,
  const char *source_path,
  char resolved[MAX_PATH_BYTES + 1U],
  char href_digest[DIGEST_TEXT_BYTES + 1U]
) {
  unsigned char href_bytes[MAX_PATH_BYTES + 1U];
  size_t href_length = 0U;
  if (!decode_canonical_base64(
        encoded_base64, href_bytes, MAX_PATH_BYTES, &href_length
      ) || !strict_utf8(href_bytes, href_length)) return HREF_INVALID;
  href_bytes[href_length] = '\0';
  sha256_prefixed(href_bytes, href_length, href_digest);
  const char *raw = (const char *)href_bytes;
  if (remote_or_absolute_href(raw) || strchr(raw, '\\') != NULL || strchr(raw, '?') != NULL) {
    return HREF_EXCLUDED;
  }
  const char *fragment = strchr(raw, '#');
  size_t path_href_length = fragment == NULL ? href_length : (size_t)(fragment - raw);
  if (path_href_length == 0U) return HREF_EXCLUDED;
  char decoded[MAX_PATH_BYTES + 1U];
  size_t output = 0U;
  for (size_t index = 0U; index < path_href_length; index += 1U) {
    unsigned char value = href_bytes[index];
    if (value == '%') {
      if (index + 2U >= path_href_length) return HREF_EXCLUDED;
      bool ok = true;
      unsigned char high = hex_nibble((char)tolower(href_bytes[index + 1U]), &ok);
      unsigned char low = hex_nibble((char)tolower(href_bytes[index + 2U]), &ok);
      if (!ok) return HREF_EXCLUDED;
      value = (unsigned char)((high << 4U) | low);
      index += 2U;
    }
    if (value < 0x20U || value == 0x7fU || value == '\\' || value == '%' ||
        output >= MAX_PATH_BYTES) return HREF_EXCLUDED;
    decoded[output++] = (char)value;
  }
  decoded[output] = '\0';
  if (output == 0U || !strict_utf8((const unsigned char *)decoded, output) ||
      remote_or_absolute_href(decoded)) return HREF_EXCLUDED;
  char components[MAX_ROOT_COMPONENTS][256];
  size_t component_count = 0U;
  char source_copy[MAX_PATH_BYTES + 1U];
  memcpy(source_copy, source_path, strlen(source_path) + 1U);
  char *source_leaf = strrchr(source_copy, '/');
  if (source_leaf != NULL) {
    *source_leaf = '\0';
    char *part = source_copy;
    while (part != NULL && part[0] != '\0') {
      char *slash = strchr(part, '/');
      if (slash != NULL) *slash = '\0';
      size_t length = strlen(part);
      if (length == 0U || length > 255U || component_count >= MAX_ROOT_COMPONENTS) {
        return HREF_EXCLUDED;
      }
      memcpy(components[component_count++], part, length + 1U);
      part = slash == NULL ? NULL : slash + 1U;
    }
  }
  char *part = decoded;
  while (part != NULL) {
    char *slash = strchr(part, '/');
    if (slash != NULL) *slash = '\0';
    size_t length = strlen(part);
    if (length == 0U || length > 255U) return HREF_EXCLUDED;
    if (strcmp(part, ".") == 0) {
      // Stay at the current descriptor-relative parent.
    } else if (strcmp(part, "..") == 0) {
      if (component_count == 0U) return HREF_EXCLUDED;
      component_count -= 1U;
    } else {
      if (part[0] == '.' || strcmp(part, "node_modules") == 0 ||
          component_count >= MAX_ROOT_COMPONENTS) return HREF_EXCLUDED;
      memcpy(components[component_count++], part, length + 1U);
    }
    part = slash == NULL ? NULL : slash + 1U;
  }
  size_t used = 0U;
  for (size_t index = 0U; index < component_count; index += 1U) {
    int length = snprintf(
      resolved + used,
      (MAX_PATH_BYTES + 1U) - used,
      "%s%s",
      index == 0U ? "" : "/",
      components[index]
    );
    if (length <= 0 || (size_t)length >= (MAX_PATH_BYTES + 1U) - used) return HREF_EXCLUDED;
    used += (size_t)length;
  }
  return used > 0U && public_path_bytes(resolved) && image_path(resolved)
    ? HREF_ELIGIBLE
    : HREF_EXCLUDED;
}

static bool expected_locator_digest(
  const char *file_id,
  const char *revision,
  uint64_t ordinal,
  const char *raw_digest,
  const char *href_digest,
  char out[DIGEST_TEXT_BYTES + 1U]
) {
  char canonical[1024];
  int length = snprintf(
    canonical,
    sizeof(canonical),
    "{\"fileId\":\"%s\",\"hrefSha256\":\"%s\",\"rawTokenSha256\":\"%s\""
    ",\"revision\":\"%s\",\"schema\":\"writcraft.snapshot-image-token-locator/v1\""
    ",\"tokenOrdinal\":%" PRIu64 "}",
    file_id,
    href_digest,
    raw_digest,
    revision,
    ordinal
  );
  return length > 0 && (size_t)length < sizeof(canonical) && digest_domain(
    "writcraft.snapshot-image-token-locator/v1", canonical, out
  );
}

static bool append_image_reference(
  SealedCapture *capture,
  const CaptureImageReference *reference
) {
  if (capture->image_reference_count >= MAX_IMAGE_TOKENS) return false;
  CaptureImageReference *resized = realloc(
    capture->image_references,
    (capture->image_reference_count + 1U) * sizeof(*capture->image_references)
  );
  if (resized == NULL) return false;
  capture->image_references = resized;
  capture->image_references[capture->image_reference_count++] = *reference;
  return true;
}

typedef enum {
  IMAGE_CAPTURE_UNAVAILABLE = 0,
  IMAGE_CAPTURE_INCLUDED = 1,
  IMAGE_CAPTURE_FATAL = 2,
} ImageCaptureResult;

static bool unavailable_path_errno(int value) {
  return value == ENOENT || value == ENOTDIR || value == ELOOP;
}

static ImageCaptureResult capture_selected_image(
  RootBinding *root,
  SealedCapture *capture,
  const char *path,
  const char **error_out
) {
  char path_copy[MAX_PATH_BYTES + 1U];
  memcpy(path_copy, path, strlen(path) + 1U);
  char *components[MAX_ROOT_COMPONENTS];
  size_t component_count = 0U;
  char *cursor = path_copy;
  while (cursor != NULL) {
    char *slash = strchr(cursor, '/');
    if (slash != NULL) *slash = '\0';
    if (cursor[0] == '\0' || component_count >= MAX_ROOT_COMPONENTS) {
      *error_out = "SOURCE_PATH";
      return IMAGE_CAPTURE_FATAL;
    }
    components[component_count++] = cursor;
    cursor = slash == NULL ? NULL : slash + 1U;
  }
  if (component_count == 0U) return IMAGE_CAPTURE_UNAVAILABLE;

  ScanAncestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  for (size_t index = 0U; index < MAX_ROOT_COMPONENTS; index += 1U) ancestors[index].fd = -1;
  int parent_fd = root->project_fd;
  size_t depth = 0U;
  ImageCaptureResult result = IMAGE_CAPTURE_FATAL;
  for (size_t index = 0U; index + 1U < component_count; index += 1U) {
    struct stat path_stat;
    if (fstatat(parent_fd, components[index], &path_stat, AT_SYMLINK_NOFOLLOW) != 0) {
      result = unavailable_path_errno(errno) ? IMAGE_CAPTURE_UNAVAILABLE : IMAGE_CAPTURE_FATAL;
      if (result == IMAGE_CAPTURE_FATAL) *error_out = "SOURCE_IO";
      goto cleanup;
    }
    Identity discovered;
    if (!identity_from_stat(&path_stat, &discovered)) {
      *error_out = "SOURCE_IO";
      goto cleanup;
    }
    if (!S_ISDIR(path_stat.st_mode)) {
      result = IMAGE_CAPTURE_UNAVAILABLE;
      goto cleanup;
    }
    int fd = openat(
      parent_fd, components[index], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    );
    if (fd < 0) {
      result = unavailable_path_errno(errno) ? IMAGE_CAPTURE_UNAVAILABLE : IMAGE_CAPTURE_FATAL;
      if (result == IMAGE_CAPTURE_FATAL) *error_out = "SOURCE_IO";
      goto cleanup;
    }
    struct stat held_stat;
    Identity held;
    if (fstat(fd, &held_stat) != 0 || !identity_from_stat(&held_stat, &held) ||
        !same_directory(&discovered, &held)) {
      (void)close(fd);
      *error_out = "SOURCE_STALE";
      goto cleanup;
    }
    memcpy(ancestors[depth].name, components[index], strlen(components[index]) + 1U);
    ancestors[depth].identity = held;
    ancestors[depth].fd = fd;
    parent_fd = fd;
    depth += 1U;
  }

  const char *leaf = components[component_count - 1U];
  struct stat discovered_stat;
  if (fstatat(parent_fd, leaf, &discovered_stat, AT_SYMLINK_NOFOLLOW) != 0) {
    result = unavailable_path_errno(errno) ? IMAGE_CAPTURE_UNAVAILABLE : IMAGE_CAPTURE_FATAL;
    if (result == IMAGE_CAPTURE_FATAL) *error_out = "SOURCE_IO";
    goto cleanup;
  }
  Identity discovered;
  if (!identity_from_stat(&discovered_stat, &discovered)) {
    *error_out = "SOURCE_IO";
    goto cleanup;
  }
  if (!S_ISREG(discovered_stat.st_mode) || discovered.nlink != 1U) {
    result = IMAGE_CAPTURE_UNAVAILABLE;
    goto cleanup;
  }
  if (discovered.size > MAX_CAPTURE_IMAGE_BYTES ||
      capture->markdown_bytes > MAX_CAPTURE_TOTAL_BYTES - capture->image_bytes ||
      discovered.size > MAX_CAPTURE_TOTAL_BYTES - capture->markdown_bytes - capture->image_bytes) {
    *error_out = "SOURCE_BUDGET";
    goto cleanup;
  }

  int fd = openat(parent_fd, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) {
    *error_out = unavailable_path_errno(errno) ? "SOURCE_STALE" : "SOURCE_IO";
    goto cleanup;
  }
  unsigned char *bytes = malloc(discovered.size == 0U ? 1U : (size_t)discovered.size);
  struct stat held_stat;
  struct stat at_path_stat;
  Identity held;
  Identity at_path;
  bool valid = bytes != NULL && fstat(fd, &held_stat) == 0 &&
    fstatat(parent_fd, leaf, &at_path_stat, AT_SYMLINK_NOFOLLOW) == 0 &&
    identity_from_stat(&held_stat, &held) && identity_from_stat(&at_path_stat, &at_path) &&
    same_regular_identity(&discovered, &held) && same_regular_identity(&discovered, &at_path) &&
    (held.size == 0U || pread_exact(fd, bytes, (size_t)held.size, 0U)) &&
    revalidate_scan_ancestors(root, ancestors, depth);
  struct stat after_stat;
  struct stat after_path_stat;
  Identity after;
  Identity after_path;
  valid = valid && fstat(fd, &after_stat) == 0 &&
    fstatat(parent_fd, leaf, &after_path_stat, AT_SYMLINK_NOFOLLOW) == 0 &&
    identity_from_stat(&after_stat, &after) && identity_from_stat(&after_path_stat, &after_path) &&
    same_regular_identity(&discovered, &after) && same_regular_identity(&discovered, &after_path);
  (void)close(fd);
  if (!valid) {
    free(bytes);
    *error_out = "SOURCE_STALE";
    goto cleanup;
  }

  CaptureEntry entry;
  memset(&entry, 0, sizeof(entry));
  entry.kind = CAPTURE_IMAGE;
  memcpy(entry.path, path, strlen(path) + 1U);
  entry.byte_length = held.size;
  entry.identity = held;
  entry.bytes = bytes;
  sha256_prefixed(bytes, (size_t)held.size, entry.content_sha256);
  opaque_capture_id("file_", capture->transaction_id, capture->snapshot_id, path, entry.opaque_id);
  if (!compute_ancestor_identity_digest(ancestors, depth, entry.ancestor_identity_digest) ||
      !compute_source_object_identity_digest(
        &held, entry.content_sha256, entry.source_object_identity_digest
      ) || !append_capture_entry(capture, &entry)) {
    free(bytes);
    *error_out = "SOURCE_LIMIT";
    goto cleanup;
  }
  capture->image_count += 1U;
  capture->image_bytes += held.size;
  result = IMAGE_CAPTURE_INCLUDED;

cleanup:
  for (size_t index = 0U; index < depth; index += 1U) {
    if (ancestors[index].fd >= 0) (void)close(ancestors[index].fd);
  }
  return result;
}

static int compare_image_reference_path(const void *left, const void *right) {
  const CaptureImageReference *a = left;
  const CaptureImageReference *b = right;
  int order = strcmp(a->resolved_path, b->resolved_path);
  if (order != 0) return order;
  order = strcmp(a->from_file_id, b->from_file_id);
  if (order != 0) return order;
  if (a->token_ordinal != b->token_ordinal) return a->token_ordinal < b->token_ordinal ? -1 : 1;
  return strcmp(a->locator_digest, b->locator_digest);
}

static bool capture_selected_images(
  RootBinding *root,
  StorageBinding *storage,
  SealedCapture *capture,
  const char **error_out
) {
  if (capture->image_reference_count > 1U) qsort(
    capture->image_references,
    capture->image_reference_count,
    sizeof(*capture->image_references),
    compare_image_reference_path
  );
  size_t unique_count = 0U;
  const char *previous = NULL;
  for (size_t index = 0U; index < capture->image_reference_count; index += 1U) {
    const char *path = capture->image_references[index].resolved_path;
    if (previous != NULL && strcmp(previous, path) == 0) continue;
    previous = path;
    unique_count += 1U;
    if (unique_count > MAX_CAPTURE_IMAGES) {
      *error_out = "SOURCE_BUDGET";
      return false;
    }
    ImageCaptureResult result = capture_selected_image(root, capture, path, error_out);
    if (result == IMAGE_CAPTURE_FATAL) return false;
  }
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    *error_out = "SOURCE_STALE";
    return false;
  }
  if (capture->entry_count > 1U) qsort(
    capture->entries, capture->entry_count, sizeof(*capture->entries), compare_capture_entry
  );
  return true;
}

static void free_byte_buffer(ByteBuffer *buffer) {
  free(buffer->bytes);
  memset(buffer, 0, sizeof(*buffer));
}

static bool reserve_byte_buffer(ByteBuffer *buffer, size_t additional, size_t limit) {
  if (additional > limit - buffer->length) return false;
  size_t needed = buffer->length + additional;
  if (needed <= buffer->capacity) return true;
  size_t capacity = buffer->capacity == 0U ? 4096U : buffer->capacity;
  while (capacity < needed) {
    if (capacity > limit / 2U) {
      capacity = limit;
      break;
    }
    capacity *= 2U;
  }
  unsigned char *resized = realloc(buffer->bytes, capacity);
  if (resized == NULL) return false;
  buffer->bytes = resized;
  buffer->capacity = capacity;
  return true;
}

static bool append_buffer_bytes(
  ByteBuffer *buffer,
  const void *bytes,
  size_t length,
  size_t limit
) {
  if (!reserve_byte_buffer(buffer, length, limit)) return false;
  memcpy(buffer->bytes + buffer->length, bytes, length);
  buffer->length += length;
  return true;
}

static bool append_buffer_text(ByteBuffer *buffer, const char *text, size_t limit) {
  return append_buffer_bytes(buffer, text, strlen(text), limit);
}

static bool append_buffer_format(ByteBuffer *buffer, size_t limit, const char *format, ...) {
  char local[4096];
  va_list arguments;
  va_start(arguments, format);
  int length = vsnprintf(local, sizeof(local), format, arguments);
  va_end(arguments);
  return length >= 0 && (size_t)length < sizeof(local) &&
    append_buffer_bytes(buffer, local, (size_t)length, limit);
}

static bool append_json_string(ByteBuffer *buffer, const char *value, size_t limit) {
  if (!append_buffer_text(buffer, "\"", limit)) return false;
  const unsigned char *start = (const unsigned char *)value;
  const unsigned char *cursor = start;
  while (*cursor != '\0') {
    if (*cursor == '"' || *cursor == '\\') {
      if (cursor > start && !append_buffer_bytes(buffer, start, (size_t)(cursor - start), limit)) {
        return false;
      }
      unsigned char escaped[2] = {'\\', *cursor};
      if (!append_buffer_bytes(buffer, escaped, sizeof(escaped), limit)) return false;
      cursor += 1U;
      start = cursor;
      continue;
    }
    if (*cursor < 0x20U) return false;
    cursor += 1U;
  }
  return append_buffer_bytes(buffer, start, (size_t)(cursor - start), limit) &&
    append_buffer_text(buffer, "\"", limit);
}

static void uint32_bytes(uint32_t value, unsigned char out[4]) {
  out[0] = (unsigned char)(value >> 24U);
  out[1] = (unsigned char)(value >> 16U);
  out[2] = (unsigned char)(value >> 8U);
  out[3] = (unsigned char)value;
}

static void uint64_bytes(uint64_t value, unsigned char out[8]) {
  for (size_t index = 0U; index < 8U; index += 1U) {
    out[7U - index] = (unsigned char)(value & 0xffU);
    value >>= 8U;
  }
}

static bool build_entry_header(const CaptureEntry *entry, ByteBuffer *header) {
  const char *kind = entry->kind == CAPTURE_MARKDOWN ? "markdown" : "image";
  return append_buffer_format(
      header, MAX_HEADER_BYTES,
      "{\"byteLength\":%" PRIu64 ",\"fileId\":\"%s\",\"kind\":\"%s\",\"path\":",
      entry->byte_length, entry->opaque_id, kind
    ) && append_json_string(header, entry->path, MAX_HEADER_BYTES) &&
    append_buffer_format(
      header, MAX_HEADER_BYTES,
      ",\"schema\":\"writcraft.snapshot-bundle-entry/v1\",\"sha256\":\"%s\"}",
      entry->content_sha256
    );
}

static bool compute_bundle_object_digest_memory(
  const ByteBuffer *header,
  const CaptureEntry *entry,
  char out[DIGEST_TEXT_BYTES + 1U]
) {
  static const char domain[] = "writcraft-snapshot-object/v1";
  unsigned char zero = 0U;
  unsigned char header_length[4];
  unsigned char content_length[8];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (header->length > UINT32_MAX) return false;
  uint32_bytes((uint32_t)header->length, header_length);
  uint64_bytes(entry->byte_length, content_length);
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  CC_SHA256_Update(&context, domain, (CC_LONG)(sizeof(domain) - 1U));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, header_length, sizeof(header_length));
  CC_SHA256_Update(&context, header->bytes, (CC_LONG)header->length);
  CC_SHA256_Update(&context, content_length, sizeof(content_length));
  CC_SHA256_Update(&context, entry->bytes, (CC_LONG)entry->byte_length);
  CC_SHA256_Final(digest, &context);
  memcpy(out, "sha256:", 7U);
  digest_hex(digest, out + 7U);
  return true;
}

static bool build_revision_set(const SealedCapture *capture, char digest[DIGEST_TEXT_BYTES + 1U]) {
  ByteBuffer canonical = {0};
  bool valid = append_buffer_text(&canonical, "{\"items\":[", MAX_MANIFEST_BYTES);
  for (size_t index = 0U; valid && index < capture->entry_count; index += 1U) {
    const CaptureEntry *entry = &capture->entries[index];
    valid = append_buffer_format(
        &canonical, MAX_MANIFEST_BYTES,
        "%s{\"fileId\":\"%s\",\"path\":", index == 0U ? "" : ",", entry->opaque_id
      ) && append_json_string(&canonical, entry->path, MAX_MANIFEST_BYTES) &&
      append_buffer_format(
        &canonical, MAX_MANIFEST_BYTES,
        ",\"revision\":\"%s\",\"sha256\":\"%s\"}",
        entry->content_sha256 + 7U, entry->content_sha256
      );
  }
  valid = valid && append_buffer_text(
    &canonical, "],\"schema\":\"writcraft.file-revision-set/v1\"}", MAX_MANIFEST_BYTES
  );
  if (valid) {
    if (!reserve_byte_buffer(&canonical, 1U, MAX_MANIFEST_BYTES + 1U)) valid = false;
    else {
      canonical.bytes[canonical.length] = '\0';
      valid = digest_domain(
        "writcraft.file-revision-set/v1", (const char *)canonical.bytes, digest
      );
    }
  }
  free_byte_buffer(&canonical);
  return valid;
}

static bool append_image_references(
  ByteBuffer *manifest,
  const SealedCapture *capture,
  const CaptureEntry *image
) {
  bool first = true;
  size_t count = 0U;
  for (size_t index = 0U; index < capture->image_reference_count; index += 1U) {
    const CaptureImageReference *reference = &capture->image_references[index];
    if (strcmp(reference->resolved_path, image->path) != 0) continue;
    count += 1U;
    if (count > 2000U) return false;
    if (!append_buffer_format(
          manifest, MAX_MANIFEST_BYTES,
          "%s{\"fromFileId\":\"%s\",\"locatorDigest\":\"%s\",\"tokenOrdinal\":%" PRIu64 "}",
          first ? "" : ",", reference->from_file_id, reference->locator_digest,
          reference->token_ordinal
        )) return false;
    first = false;
  }
  return true;
}

static bool append_manifest_files(ByteBuffer *manifest, const SealedCapture *capture) {
  for (size_t index = 0U; index < capture->entry_count; index += 1U) {
    const CaptureEntry *entry = &capture->entries[index];
    const char *kind = entry->kind == CAPTURE_MARKDOWN ? "markdown" : "image";
    if (!append_buffer_format(
          manifest, MAX_MANIFEST_BYTES,
          "%s{\"ancestorIdentityDigest\":\"%s\",\"bundleObjectDigest\":\"%s\""
          ",\"byteLength\":%" PRIu64 ",\"fileId\":\"%s\",\"kind\":\"%s\",\"mode\":%" PRIuMAX
          ",\"path\":",
          index == 0U ? "" : ",", entry->ancestor_identity_digest,
          entry->bundle_object_digest, entry->byte_length, entry->opaque_id, kind,
          permission_mode(entry->identity.mode)
        ) || !append_json_string(manifest, entry->path, MAX_MANIFEST_BYTES) ||
        !append_buffer_text(manifest, ",\"references\":[", MAX_MANIFEST_BYTES) ||
        (entry->kind == CAPTURE_IMAGE && !append_image_references(manifest, capture, entry)) ||
        !append_buffer_format(
          manifest, MAX_MANIFEST_BYTES,
          "],\"revision\":\"%s\",\"sha256\":\"%s\",\"sourceObjectIdentityDigest\":\"%s\"}",
          entry->content_sha256 + 7U, entry->content_sha256,
          entry->source_object_identity_digest
        )) return false;
  }
  return true;
}

static bool build_manifest_once(
  const RootBinding *root,
  const SealedCapture *capture,
  const char *revision_set_digest,
  uint64_t manifest_bytes,
  const char *manifest_digest,
  bool include_digest,
  ByteBuffer *manifest
) {
  bool valid = append_buffer_format(
    manifest, MAX_MANIFEST_BYTES,
    "{\"budgets\":{\"limits\":{\"maxControlRecordBytes\":1048576,\"maxImageFileBytes\":26214400,"
    "\"maxImageFiles\":200,\"maxManifestBytes\":4194304,\"maxMarkdownFileBytes\":4194304,"
    "\"maxMarkdownFiles\":300,\"maxMarkdownTotalBytes\":67108864,"
    "\"maxPrivateMetadataBytes\":8388608,\"maxSnapshotBytes\":536870912,\"maxTotalItems\":500},"
    "\"observed\":{\"imageBytes\":%" PRIu64 ",\"imageFiles\":%zu,\"manifestBytes\":%" PRIu64
    ",\"markdownBytes\":%" PRIu64 ",\"markdownFiles\":%zu,\"privateMetadataBytes\":0,"
    "\"snapshotBytes\":%" PRIu64 ",\"totalItems\":%zu}},\"createdAt\":\"%s\""
    ",\"creationMutationGeneration\":%" PRIu64 ",\"fileRevisionSetDigest\":\"%s\",\"files\":[",
    capture->image_bytes, capture->image_count, manifest_bytes, capture->markdown_bytes,
    capture->markdown_count, capture->markdown_bytes + capture->image_bytes,
    capture->entry_count, capture->created_at, capture->mutation_generation, revision_set_digest
  );
  valid = valid && append_manifest_files(manifest, capture) && append_buffer_format(
    manifest, MAX_MANIFEST_BYTES,
    "],\"producerVersion\":\"" WRITCRAFT_APP_VERSION "\",\"projectInstanceId\":\"%s\""
    ",\"rootIdentityDigest\":\"%s\",\"schema\":\"writcraft.snapshot/v1\""
    ",\"snapshotId\":\"%s\"",
    capture->project_instance_id, root->root_identity_digest, capture->snapshot_id
  );
  if (valid && include_digest) valid = append_buffer_format(
    manifest, MAX_MANIFEST_BYTES, ",\"snapshotManifestDigest\":\"%s\"", manifest_digest
  );
  return valid && append_buffer_text(manifest, "}", MAX_MANIFEST_BYTES);
}

static bool build_snapshot_bundle(
  const RootBinding *root,
  SealedCapture *capture,
  ByteBuffer *bundle,
  char manifest_digest[DIGEST_TEXT_BYTES + 1U],
  char payload_digest[DIGEST_TEXT_BYTES + 1U]
) {
  if (capture->entry_count == 0U || capture->entry_count > MAX_ENTRIES) return false;
  for (size_t index = 0U; index < capture->entry_count; index += 1U) {
    ByteBuffer header = {0};
    bool valid = build_entry_header(&capture->entries[index], &header) &&
      compute_bundle_object_digest_memory(
        &header, &capture->entries[index], capture->entries[index].bundle_object_digest
      );
    free_byte_buffer(&header);
    if (!valid) return false;
  }
  char revision_set_digest[DIGEST_TEXT_BYTES + 1U];
  if (!build_revision_set(capture, revision_set_digest)) return false;
  uint64_t observed_manifest_bytes = 0U;
  ByteBuffer manifest = {0};
  for (size_t attempt = 0U; attempt < 8U; attempt += 1U) {
    ByteBuffer preimage = {0};
    if (!build_manifest_once(
          root, capture, revision_set_digest, observed_manifest_bytes, NULL, false, &preimage
        ) || !reserve_byte_buffer(&preimage, 1U, MAX_MANIFEST_BYTES + 1U)) {
      free_byte_buffer(&preimage);
      free_byte_buffer(&manifest);
      return false;
    }
    preimage.bytes[preimage.length] = '\0';
    bool digested = digest_domain(
      "writcraft.snapshot/v1", (const char *)preimage.bytes, manifest_digest
    );
    free_byte_buffer(&preimage);
    free_byte_buffer(&manifest);
    if (!digested || !build_manifest_once(
          root, capture, revision_set_digest, observed_manifest_bytes,
          manifest_digest, true, &manifest
        )) {
      free_byte_buffer(&manifest);
      return false;
    }
    if (manifest.length == observed_manifest_bytes) break;
    observed_manifest_bytes = manifest.length;
  }
  if (manifest.length != observed_manifest_bytes || manifest.length > UINT32_MAX) {
    free_byte_buffer(&manifest);
    return false;
  }

  unsigned char encoded32[4];
  unsigned char encoded64[8];
  uint32_bytes((uint32_t)manifest.length, encoded32);
  bool valid = append_buffer_bytes(bundle, BUNDLE_MAGIC, sizeof(BUNDLE_MAGIC), MAX_BUNDLE_BYTES) &&
    append_buffer_bytes(bundle, encoded32, sizeof(encoded32), MAX_BUNDLE_BYTES) &&
    append_buffer_bytes(bundle, manifest.bytes, manifest.length, MAX_BUNDLE_BYTES);
  uint32_bytes((uint32_t)capture->entry_count, encoded32);
  valid = valid && append_buffer_bytes(bundle, encoded32, sizeof(encoded32), MAX_BUNDLE_BYTES);
  for (size_t index = 0U; valid && index < capture->entry_count; index += 1U) {
    CaptureEntry *entry = &capture->entries[index];
    ByteBuffer header = {0};
    valid = build_entry_header(entry, &header) && header.length <= UINT32_MAX;
    if (valid) {
      uint32_bytes((uint32_t)header.length, encoded32);
      uint64_bytes(entry->byte_length, encoded64);
      valid = append_buffer_bytes(bundle, encoded32, sizeof(encoded32), MAX_BUNDLE_BYTES) &&
        append_buffer_bytes(bundle, header.bytes, header.length, MAX_BUNDLE_BYTES) &&
        append_buffer_bytes(bundle, encoded64, sizeof(encoded64), MAX_BUNDLE_BYTES) &&
        append_buffer_bytes(bundle, entry->bytes, (size_t)entry->byte_length, MAX_BUNDLE_BYTES);
    }
    free_byte_buffer(&header);
  }
  free_byte_buffer(&manifest);
  if (!valid || bundle->length > MAX_BUNDLE_BYTES - 40U) return false;
  unsigned char raw[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bundle->bytes, (CC_LONG)bundle->length, raw);
  memcpy(payload_digest, "sha256:", 7U);
  digest_hex(raw, payload_digest + 7U);
  return append_buffer_bytes(bundle, raw, sizeof(raw), MAX_BUNDLE_BYTES) &&
    append_buffer_bytes(bundle, BUNDLE_FOOTER, sizeof(BUNDLE_FOOTER), MAX_BUNDLE_BYTES);
}

static bool exact_capture_entry(const CaptureEntry *left, const CaptureEntry *right) {
  return left->kind == right->kind && strcmp(left->path, right->path) == 0 &&
    left->byte_length == right->byte_length &&
    same_regular_identity(&left->identity, &right->identity) &&
    strcmp(left->ancestor_identity_digest, right->ancestor_identity_digest) == 0 &&
    strcmp(left->source_object_identity_digest, right->source_object_identity_digest) == 0 &&
    strcmp(left->content_sha256, right->content_sha256) == 0 &&
    memcmp(left->bytes, right->bytes, (size_t)left->byte_length) == 0;
}

static bool recheck_capture_sources(
  RootBinding *root,
  StorageBinding *storage,
  const SealedCapture *capture
) {
  SealedCapture observed;
  memset(&observed, 0, sizeof(observed));
  memcpy(observed.transaction_id, capture->transaction_id, strlen(capture->transaction_id) + 1U);
  memcpy(observed.snapshot_id, capture->snapshot_id, strlen(capture->snapshot_id) + 1U);
  ScanAncestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  const char *error = "SOURCE_IO";
  bool valid = revalidate_root(root) && revalidate_storage(root, storage) &&
    scan_capture_directory(root, root->project_fd, "", ancestors, 0U, &observed, &error);
  for (size_t index = 0U; valid && index < capture->entry_count; index += 1U) {
    if (capture->entries[index].kind != CAPTURE_IMAGE) continue;
    ImageCaptureResult result = capture_selected_image(
      root, &observed, capture->entries[index].path, &error
    );
    valid = result == IMAGE_CAPTURE_INCLUDED;
  }
  if (valid && observed.entry_count > 1U) qsort(
    observed.entries, observed.entry_count, sizeof(*observed.entries), compare_capture_entry
  );
  valid = valid && observed.entry_count == capture->entry_count;
  for (size_t index = 0U; valid && index < capture->entry_count; index += 1U) {
    valid = exact_capture_entry(&capture->entries[index], &observed.entries[index]);
  }
  valid = valid && revalidate_root(root) && revalidate_storage(root, storage);
  free_sealed_capture(&observed);
  return valid;
}

static bool parse_token_object(
  CanonicalJsonInput *input,
  const CaptureEntry *entry,
  SealedCapture *capture,
  uint64_t *previous_ordinal
) {
  char href_base64[5465];
  char locator[DIGEST_TEXT_BYTES + 1U];
  char raw_digest[DIGEST_TEXT_BYTES + 1U];
  uint64_t ordinal = 0U;
  if (!json_literal(input, "{\"hrefUtf8Base64\":" ) ||
      !json_ascii_string(input, href_base64, sizeof(href_base64), false) ||
      !json_literal(input, ",\"locatorDigest\":" ) ||
      !json_ascii_string(input, locator, sizeof(locator), false) ||
      !json_literal(input, ",\"rawTokenSha256\":" ) ||
      !json_ascii_string(input, raw_digest, sizeof(raw_digest), false) ||
      !json_literal(input, ",\"tokenOrdinal\":" ) || !json_uint64(input, &ordinal) ||
      !json_literal(input, "}" ) || !valid_digest(locator) || !valid_digest(raw_digest) ||
      (*previous_ordinal != UINT64_MAX && ordinal <= *previous_ordinal)) return false;
  char resolved[MAX_PATH_BYTES + 1U];
  char href_digest[DIGEST_TEXT_BYTES + 1U];
  char expected[DIGEST_TEXT_BYTES + 1U];
  ImageHrefStatus href_status = decode_image_href(
    href_base64, entry->path, resolved, href_digest
  );
  if (href_status == HREF_INVALID || !expected_locator_digest(
        entry->opaque_id, entry->content_sha256 + 7U, ordinal, raw_digest, href_digest, expected
      ) || strcmp(locator, expected) != 0 || capture->image_token_count >= MAX_IMAGE_TOKENS) {
    return false;
  }
  capture->image_token_count += 1U;
  *previous_ordinal = ordinal;
  if (href_status == HREF_EXCLUDED) return true;
  CaptureImageReference reference;
  memset(&reference, 0, sizeof(reference));
  memcpy(reference.from_file_id, entry->opaque_id, strlen(entry->opaque_id) + 1U);
  reference.token_ordinal = ordinal;
  memcpy(reference.raw_token_sha256, raw_digest, strlen(raw_digest) + 1U);
  memcpy(reference.locator_digest, locator, strlen(locator) + 1U);
  memcpy(reference.resolved_path, resolved, strlen(resolved) + 1U);
  if (!append_image_reference(capture, &reference)) return false;
  return true;
}

static bool parse_candidate_object(
  CanonicalJsonInput *input,
  const CaptureEntry *entry,
  SealedCapture *capture
) {
  char candidate_id[MAX_OPAQUE_BYTES + 1U];
  char capture_digest[DIGEST_TEXT_BYTES + 1U];
  char file_id[MAX_OPAQUE_BYTES + 1U];
  char revision[65];
  if (!json_literal(input, "{\"candidateId\":" ) ||
      !json_ascii_string(input, candidate_id, sizeof(candidate_id), false) ||
      !json_literal(input, ",\"captureDigest\":" ) ||
      !json_ascii_string(input, capture_digest, sizeof(capture_digest), false) ||
      !json_literal(input, ",\"fileId\":" ) ||
      !json_ascii_string(input, file_id, sizeof(file_id), false) ||
      !json_literal(input, ",\"revision\":" ) ||
      !json_ascii_string(input, revision, sizeof(revision), false) ||
      !json_literal(input, ",\"tokens\":[" ) ||
      strcmp(candidate_id, entry->candidate_id) != 0 ||
      strcmp(capture_digest, capture->capture_digest) != 0 ||
      strcmp(file_id, entry->opaque_id) != 0 ||
      strcmp(revision, entry->content_sha256 + 7U) != 0) return false;
  uint64_t previous = UINT64_MAX;
  bool first = true;
  while (!json_literal(input, "]")) {
    if (!first && !json_literal(input, ",")) return false;
    if (!parse_token_object(input, entry, capture, &previous)) return false;
    first = false;
  }
  return json_literal(input, "}");
}

static bool parse_image_token_pass(SealedCapture *capture) {
  CanonicalJsonInput input = {
    .cursor = (const char *)capture->token_pass_bytes,
    .end = (const char *)capture->token_pass_bytes + capture->token_pass_used,
  };
  char parser_id[sizeof(SNAPSHOT_PARSER_ID)];
  char schema[64];
  char transaction_id[MAX_OPAQUE_BYTES + 1U];
  if (!json_literal(&input, "{\"candidates\":[")) return false;
  size_t candidate_index = 0U;
  bool first = true;
  while (!json_literal(&input, "]")) {
    if (!first && !json_literal(&input, ",")) return false;
    if (candidate_index >= capture->markdown_count ||
        !parse_candidate_object(
          &input, &capture->entries[candidate_index], capture
        )) return false;
    candidate_index += 1U;
    first = false;
  }
  if (candidate_index != capture->markdown_count ||
      !json_literal(&input, ",\"parserId\":" ) ||
      !json_ascii_string(&input, parser_id, sizeof(parser_id), false) ||
      !json_literal(&input, ",\"schema\":" ) ||
      !json_ascii_string(&input, schema, sizeof(schema), false) ||
      !json_literal(&input, ",\"transactionId\":" ) ||
      !json_ascii_string(&input, transaction_id, sizeof(transaction_id), false) ||
      !json_literal(&input, "}" ) || input.cursor != input.end ||
      strcmp(parser_id, SNAPSHOT_PARSER_ID) != 0 ||
      strcmp(schema, "writcraft.snapshot-image-token-pass/v1") != 0 ||
      strcmp(transaction_id, capture->transaction_id) != 0) return false;
  return true;
}

static bool begin_token_pass(char *line, SealedCapture *capture) {
  char *fields[3];
  size_t count = 0U;
  uint64_t expected = 0U;
  if (!split_fields(line, fields, 3U, &count) || count != 3U || strcmp(fields[0], "T") != 0 ||
      !capture->active || strcmp(fields[1], capture->transaction_id) != 0 ||
      !decimal_uint64(fields[2], &expected) || expected == 0U ||
      expected > MAX_TOKEN_PASS_BYTES || capture->token_pass_bytes != NULL) {
    return write_error('T', "PROTOCOL") && false;
  }
  capture->token_pass_bytes = malloc((size_t)expected + 1U);
  if (capture->token_pass_bytes == NULL) return write_error('T', "TOKEN_BUDGET") && false;
  capture->token_pass_expected = (size_t)expected;
  capture->token_pass_used = 0U;
  char response[256];
  int length = snprintf(response, sizeof(response), "T\tOK\t%s\t%" PRIu64 "\n", fields[1], expected);
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static bool write_token_pass_chunk(char *line, SealedCapture *capture) {
  char *fields[3];
  size_t count = 0U;
  unsigned char chunk[MAX_CHUNK_BYTES];
  size_t chunk_length = 0U;
  if (!split_fields(line, fields, 3U, &count) || count != 3U || strcmp(fields[0], "U") != 0 ||
      !capture->active || capture->token_pass_bytes == NULL ||
      strcmp(fields[1], capture->transaction_id) != 0 ||
      !decode_hex(fields[2], chunk, sizeof(chunk), &chunk_length) ||
      chunk_length > capture->token_pass_expected - capture->token_pass_used) {
    return write_error('U', "PROTOCOL") && false;
  }
  memcpy(capture->token_pass_bytes + capture->token_pass_used, chunk, chunk_length);
  capture->token_pass_used += chunk_length;
  char response[256];
  int length = snprintf(
    response, sizeof(response), "U\tOK\t%s\t%zu\n", fields[1], capture->token_pass_used
  );
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static bool finish_token_pass(
  char *line,
  RootBinding *root,
  StorageBinding *storage,
  SealedCapture *capture
) {
  char *fields[2];
  size_t count = 0U;
  if (!split_fields(line, fields, 2U, &count) || count != 2U || strcmp(fields[0], "K") != 0 ||
      !capture->active || capture->token_pass_bytes == NULL ||
      strcmp(fields[1], capture->transaction_id) != 0 ||
      capture->token_pass_used != capture->token_pass_expected) {
    return write_error('K', "PROTOCOL") && false;
  }
  capture->token_pass_bytes[capture->token_pass_used] = '\0';
  if (!parse_image_token_pass(capture)) return write_error('K', "TOKEN_PASS") && false;
  const char *error = "SOURCE_IO";
  if (!capture_selected_images(root, storage, capture, &error)) {
    return write_error('K', error) && false;
  }
  char response[256];
  int length = snprintf(
    response,
    sizeof(response),
    "K\tOK\t%s\t%zu\t%zu\n",
    fields[1],
    capture->image_reference_count,
    capture->image_count
  );
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static size_t count_bytes_token(
  const unsigned char *bytes,
  size_t length,
  const char *token
) {
  size_t token_length = strlen(token);
  if (token_length == 0U || token_length > length) return 0U;
  size_t count = 0U;
  for (size_t index = 0U; index + token_length <= length; index += 1U) {
    if (memcmp(bytes + index, token, token_length) == 0) count += 1U;
  }
  return count;
}

static bool extract_ascii_json_string(
  const unsigned char *bytes,
  size_t length,
  const char *key_prefix,
  char *out,
  size_t capacity
) {
  size_t prefix_length = strlen(key_prefix);
  if (count_bytes_token(bytes, length, key_prefix) != 1U) return false;
  const unsigned char *start = NULL;
  for (size_t index = 0U; index + prefix_length <= length; index += 1U) {
    if (memcmp(bytes + index, key_prefix, prefix_length) == 0) {
      start = bytes + index + prefix_length;
      break;
    }
  }
  if (start == NULL) return false;
  const unsigned char *end = start;
  const unsigned char *limit = bytes + length;
  while (end < limit && *end != '"') {
    if (*end < 0x20U || *end > 0x7eU || *end == '\\') return false;
    end += 1U;
  }
  size_t value_length = (size_t)(end - start);
  if (end >= limit || value_length == 0U || value_length >= capacity) return false;
  memcpy(out, start, value_length);
  out[value_length] = '\0';
  return true;
}

static bool extract_json_uint64(
  const unsigned char *bytes,
  size_t length,
  const char *key_prefix,
  uint64_t *out
) {
  size_t prefix_length = strlen(key_prefix);
  if (count_bytes_token(bytes, length, key_prefix) != 1U) return false;
  const unsigned char *start = NULL;
  for (size_t index = 0U; index + prefix_length <= length; index += 1U) {
    if (memcmp(bytes + index, key_prefix, prefix_length) == 0) {
      start = bytes + index + prefix_length;
      break;
    }
  }
  if (start == NULL) return false;
  char decimal[32];
  size_t used = 0U;
  const unsigned char *limit = bytes + length;
  while (start < limit && *start >= '0' && *start <= '9' && used + 1U < sizeof(decimal)) {
    decimal[used++] = (char)*start++;
  }
  decimal[used] = '\0';
  return used > 0U && decimal_uint64(decimal, out);
}

static bool verify_manifest_self_digest(
  const unsigned char *manifest,
  size_t length,
  const char *expected_digest
) {
  static const char field[] = ",\"snapshotManifestDigest\":\"";
  size_t field_length = sizeof(field) - 1U;
  if (count_bytes_token(manifest, length, field) != 1U) return false;
  size_t field_offset = 0U;
  while (field_offset + field_length <= length &&
      memcmp(manifest + field_offset, field, field_length) != 0) field_offset += 1U;
  if (field_offset + field_length + DIGEST_TEXT_BYTES + 2U != length ||
      memcmp(manifest + field_offset + field_length, expected_digest, DIGEST_TEXT_BYTES) != 0 ||
      manifest[length - 2U] != '"' || manifest[length - 1U] != '}') return false;
  static const char domain[] = "writcraft-digest/v1";
  static const char schema[] = "writcraft.snapshot/v1";
  unsigned char zero = 0U;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  char actual[DIGEST_TEXT_BYTES + 1U];
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  CC_SHA256_Update(&context, domain, (CC_LONG)(sizeof(domain) - 1U));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, schema, (CC_LONG)(sizeof(schema) - 1U));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, manifest, (CC_LONG)field_offset);
  CC_SHA256_Update(&context, "}", 1U);
  CC_SHA256_Final(digest, &context);
  memcpy(actual, "sha256:", 7U);
  digest_hex(digest, actual + 7U);
  return strcmp(actual, expected_digest) == 0;
}

static bool manifest_object_digests(
  const unsigned char *manifest,
  size_t length,
  char (*out)[DIGEST_TEXT_BYTES + 1U],
  size_t *count_out
) {
  static const char prefix[] = "\"bundleObjectDigest\":\"";
  size_t prefix_length = sizeof(prefix) - 1U;
  size_t count = 0U;
  for (size_t offset = 0U; offset + prefix_length <= length; offset += 1U) {
    if (memcmp(manifest + offset, prefix, prefix_length) != 0) continue;
    size_t value_offset = offset + prefix_length;
    if (count >= MAX_ENTRIES || value_offset + DIGEST_TEXT_BYTES >= length ||
        manifest[value_offset + DIGEST_TEXT_BYTES] != '"') return false;
    memcpy(out[count], manifest + value_offset, DIGEST_TEXT_BYTES);
    out[count][DIGEST_TEXT_BYTES] = '\0';
    if (!valid_digest(out[count])) return false;
    count += 1U;
    offset = value_offset + DIGEST_TEXT_BYTES;
  }
  *count_out = count;
  return true;
}

static bool bundle_object_digest_fd(
  int fd,
  const unsigned char length32[4],
  const unsigned char *header,
  size_t header_length,
  const unsigned char length64[8],
  uint64_t content_offset,
  uint64_t content_length,
  char out[DIGEST_TEXT_BYTES + 1U]
) {
  static const char domain[] = "writcraft-snapshot-object/v1";
  unsigned char zero = 0U;
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  CC_SHA256_Update(&context, domain, (CC_LONG)(sizeof(domain) - 1U));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, length32, 4U);
  CC_SHA256_Update(&context, header, (CC_LONG)header_length);
  CC_SHA256_Update(&context, length64, 8U);
  unsigned char bytes[HASH_CHUNK_BYTES];
  uint64_t consumed = 0U;
  while (consumed < content_length) {
    size_t requested = content_length - consumed > HASH_CHUNK_BYTES
      ? HASH_CHUNK_BYTES
      : (size_t)(content_length - consumed);
    if (!pread_exact(fd, bytes, requested, content_offset + consumed)) return false;
    CC_SHA256_Update(&context, bytes, (CC_LONG)requested);
    consumed += requested;
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  memcpy(out, "sha256:", 7U);
  digest_hex(digest, out + 7U);
  return true;
}

static bool validate_entry(
  int fd,
  const unsigned char *header,
  size_t header_length,
  uint64_t content_offset,
  uint64_t content_length
) {
  if (header_length < 2U || header[0] != '{' || header[header_length - 1U] != '}' ||
      !strict_utf8(header, header_length) ||
      count_bytes_token(header, header_length,
        "\"schema\":\"writcraft.snapshot-bundle-entry/v1\"") != 1U) return false;
  uint64_t stated_length = 0U;
  char sha[DIGEST_TEXT_BYTES + 1U];
  char kind[16];
  if (!extract_json_uint64(header, header_length, "\"byteLength\":", &stated_length) ||
      stated_length != content_length ||
      !extract_ascii_json_string(header, header_length, "\"sha256\":\"", sha, sizeof(sha)) ||
      !valid_digest(sha) ||
      !extract_ascii_json_string(header, header_length, "\"kind\":\"", kind, sizeof(kind)) ||
      (strcmp(kind, "markdown") != 0 && strcmp(kind, "image") != 0)) return false;
  unsigned char content_digest[CC_SHA256_DIGEST_LENGTH];
  char actual[DIGEST_TEXT_BYTES + 1U];
  if (!hash_fd_range(fd, content_offset, content_length, content_digest)) return false;
  memcpy(actual, "sha256:", 7U);
  digest_hex(content_digest, actual + 7U);
  if (strcmp(actual, sha) != 0) return false;
  if (strcmp(kind, "markdown") == 0) {
    if (content_length > 4ULL * 1024ULL * 1024ULL || content_length > SIZE_MAX) return false;
    unsigned char *content = malloc(content_length == 0U ? 1U : (size_t)content_length);
    if (content == NULL) return false;
    bool valid = (content_length == 0U || pread_exact(fd, content, (size_t)content_length, content_offset)) &&
      strict_utf8(content, (size_t)content_length);
    free(content);
    if (!valid) return false;
  }
  return true;
}

static bool validate_bundle_fd(
  int fd,
  const char *expected_snapshot_id,
  const char *expected_manifest_digest,
  BundleInfo *out
) {
  struct stat before_stat;
  Identity before;
  if (fstat(fd, &before_stat) != 0 || !identity_from_stat(&before_stat, &before) ||
      !S_ISREG(before_stat.st_mode) || before.size < 56U || before.size > MAX_BUNDLE_BYTES) return false;
  unsigned char magic[8];
  unsigned char footer[8];
  if (!pread_exact(fd, magic, sizeof(magic), 0U) ||
      !pread_exact(fd, footer, sizeof(footer), before.size - sizeof(footer)) ||
      memcmp(magic, BUNDLE_MAGIC, sizeof(magic)) != 0 ||
      memcmp(footer, BUNDLE_FOOTER, sizeof(footer)) != 0) return false;
  uint64_t payload_end = before.size - 40U;
  unsigned char payload_digest[CC_SHA256_DIGEST_LENGTH];
  unsigned char stored_digest[CC_SHA256_DIGEST_LENGTH];
  if (!hash_fd_range(fd, 0U, payload_end, payload_digest) ||
      !pread_exact(fd, stored_digest, sizeof(stored_digest), payload_end) ||
      memcmp(payload_digest, stored_digest, sizeof(payload_digest)) != 0) return false;
  unsigned char uint32_bytes[4];
  if (!pread_exact(fd, uint32_bytes, sizeof(uint32_bytes), 8U)) return false;
  uint32_t manifest_length = uint32_be(uint32_bytes);
  uint64_t offset = 12U;
  if (manifest_length == 0U || manifest_length > MAX_MANIFEST_BYTES ||
      offset + manifest_length + 4U > payload_end) return false;
  unsigned char *manifest = malloc(manifest_length);
  char (*object_digests)[DIGEST_TEXT_BYTES + 1U] = calloc(
    MAX_ENTRIES, sizeof(*object_digests)
  );
  if (manifest == NULL || object_digests == NULL) {
    free(manifest);
    free(object_digests);
    return false;
  }
  bool manifest_read = pread_exact(fd, manifest, manifest_length, offset);
  char snapshot_id[MAX_OPAQUE_BYTES + 1U];
  char manifest_digest[DIGEST_TEXT_BYTES + 1U];
  bool manifest_valid = manifest_read && manifest[0] == '{' && manifest[manifest_length - 1U] == '}' &&
    strict_utf8(manifest, manifest_length) &&
    count_bytes_token(manifest, manifest_length, "\"schema\":\"writcraft.snapshot/v1\"") == 1U &&
    extract_ascii_json_string(manifest, manifest_length, "\"snapshotId\":\"", snapshot_id, sizeof(snapshot_id)) &&
    extract_ascii_json_string(
      manifest, manifest_length, "\"snapshotManifestDigest\":\"", manifest_digest, sizeof(manifest_digest)
    ) && valid_opaque(snapshot_id) && valid_digest(manifest_digest) &&
    (expected_snapshot_id == NULL || strcmp(snapshot_id, expected_snapshot_id) == 0) &&
    (expected_manifest_digest == NULL || strcmp(manifest_digest, expected_manifest_digest) == 0) &&
    verify_manifest_self_digest(manifest, manifest_length, manifest_digest);
  size_t object_digest_count = 0U;
  if (manifest_valid) manifest_valid = manifest_object_digests(
    manifest, manifest_length, object_digests, &object_digest_count
  );
  free(manifest);
  if (!manifest_valid) {
    free(object_digests);
    return false;
  }
  offset += manifest_length;
  if (!pread_exact(fd, uint32_bytes, sizeof(uint32_bytes), offset)) {
    free(object_digests);
    return false;
  }
  uint32_t entry_count = uint32_be(uint32_bytes);
  offset += 4U;
  if (entry_count > MAX_ENTRIES || entry_count != object_digest_count) {
    free(object_digests);
    return false;
  }
  uint64_t content_total = 0U;
  for (uint32_t index = 0U; index < entry_count; index += 1U) {
    if (offset + 4U > payload_end || !pread_exact(fd, uint32_bytes, sizeof(uint32_bytes), offset)) {
      free(object_digests);
      return false;
    }
    unsigned char header_length_bytes[4];
    memcpy(header_length_bytes, uint32_bytes, sizeof(header_length_bytes));
    uint32_t header_length = uint32_be(uint32_bytes);
    offset += 4U;
    if (header_length == 0U || header_length > MAX_HEADER_BYTES || offset + header_length + 8U > payload_end) {
      free(object_digests);
      return false;
    }
    unsigned char *header = malloc(header_length);
    if (header == NULL || !pread_exact(fd, header, header_length, offset)) {
      free(header);
      free(object_digests);
      return false;
    }
    offset += header_length;
    unsigned char uint64_bytes[8];
    if (!pread_exact(fd, uint64_bytes, sizeof(uint64_bytes), offset)) {
      free(header);
      free(object_digests);
      return false;
    }
    uint64_t content_length = uint64_be(uint64_bytes);
    offset += 8U;
    if (content_length > MAX_CONTENT_BYTES - content_total || offset + content_length > payload_end ||
        !validate_entry(fd, header, header_length, offset, content_length)) {
      free(header);
      free(object_digests);
      return false;
    }
    char actual_object_digest[DIGEST_TEXT_BYTES + 1U];
    if (!bundle_object_digest_fd(
          fd, header_length_bytes, header, header_length, uint64_bytes,
          offset, content_length, actual_object_digest
        ) || strcmp(actual_object_digest, object_digests[index]) != 0) {
      free(header);
      free(object_digests);
      return false;
    }
    free(header);
    content_total += content_length;
    offset += content_length;
  }
  free(object_digests);
  if (offset != payload_end) return false;
  struct stat after_stat;
  Identity after;
  if (fstat(fd, &after_stat) != 0 || !identity_from_stat(&after_stat, &after) ||
      !same_regular_identity(&before, &after)) return false;
  memcpy(out->snapshot_id, snapshot_id, strlen(snapshot_id) + 1U);
  memcpy(out->snapshot_manifest_digest, manifest_digest, strlen(manifest_digest) + 1U);
  memcpy(out->payload_sha256, payload_digest, sizeof(out->payload_sha256));
  out->payload_length = payload_end;
  return true;
}

static bool record_names(
  const char *transaction_id,
  char recovery_name[96],
  char receipt_name[96]
) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  char hex[(CC_SHA256_DIGEST_LENGTH * 2U) + 1U];
  CC_SHA256(transaction_id, (CC_LONG)strlen(transaction_id), digest);
  digest_hex(digest, hex);
  int recovery_length = snprintf(recovery_name, 96U, "recovery-%s.json", hex);
  int receipt_length = snprintf(receipt_name, 96U, "receipt-%s.json", hex);
  return recovery_length > 0 && recovery_length < 96 && receipt_length > 0 && receipt_length < 96;
}

static bool compute_published_identity_digest(
  const StorageBinding *storage,
  const char *final_name,
  const Identity *identity,
  const BundleInfo *bundle,
  char out[DIGEST_TEXT_BYTES + 1U]
) {
  char final_name_digest[DIGEST_TEXT_BYTES + 1U];
  char payload_digest[DIGEST_TEXT_BYTES + 1U];
  sha256_prefixed((const unsigned char *)final_name, strlen(final_name), final_name_digest);
  memcpy(payload_digest, "sha256:", 7U);
  digest_hex(bundle->payload_sha256, payload_digest + 7U);
  char canonical[2048];
  int length = snprintf(
    canonical,
    sizeof(canonical),
    "{\"bundlePayloadSha256\":\"%s\",\"dev\":\"%" PRIuMAX
    "\",\"finalBasenameSha256\":\"%s\",\"ino\":\"%" PRIuMAX
    "\",\"mode\":%" PRIuMAX ",\"nlink\":%" PRIuMAX
    ",\"parentIdentityDigest\":\"%s\",\"schema\":\"writcraft.snapshot-published-identity/v1\""
    ",\"size\":\"%" PRIuMAX "\",\"snapshotId\":\"%s\",\"snapshotManifestDigest\":\"%s\""
    ",\"uid\":%" PRIuMAX "}",
    payload_digest,
    identity->dev,
    final_name_digest,
    identity->ino,
    permission_mode(identity->mode),
    identity->nlink,
    storage->bundles_identity_digest,
    identity->size,
    bundle->snapshot_id,
    bundle->snapshot_manifest_digest,
    identity->uid
  );
  return length > 0 && (size_t)length < sizeof(canonical) &&
    digest_domain("writcraft.snapshot-published-identity/v1", canonical, out);
}

static bool make_recovery_json(
  const RecoveryRecord *record,
  char *out,
  size_t capacity,
  char digest_out[DIGEST_TEXT_BYTES + 1U]
) {
  char without_digest[2048];
  int plain_length = snprintf(
    without_digest,
    sizeof(without_digest),
    "{\"expectedManifestDigest\":\"%s\",\"expectedPublishedIdentityDigest\":\"%s\""
    ",\"schema\":\"writcraft.snapshot-recovery/v1\",\"snapshotId\":\"%s\",\"state\":\"%s\""
    ",\"transactionId\":\"%s\",\"updatedAt\":\"%s\"}",
    record->expected_manifest_digest,
    record->expected_published_identity_digest,
    record->snapshot_id,
    record->state,
    record->transaction_id,
    record->updated_at
  );
  if (plain_length <= 0 || (size_t)plain_length >= sizeof(without_digest) ||
      !digest_domain("writcraft.snapshot-recovery/v1", without_digest, digest_out)) return false;
  int length = snprintf(
    out,
    capacity,
    "{\"expectedManifestDigest\":\"%s\",\"expectedPublishedIdentityDigest\":\"%s\""
    ",\"markerDigest\":\"%s\",\"schema\":\"writcraft.snapshot-recovery/v1\""
    ",\"snapshotId\":\"%s\",\"state\":\"%s\",\"transactionId\":\"%s\",\"updatedAt\":\"%s\"}\n",
    record->expected_manifest_digest,
    record->expected_published_identity_digest,
    digest_out,
    record->snapshot_id,
    record->state,
    record->transaction_id,
    record->updated_at
  );
  return length > 0 && (size_t)length < capacity && (size_t)length <= MAX_RECORD_BYTES;
}

static bool make_receipt_json(
  const ReceiptRecord *record,
  char *out,
  size_t capacity,
  char digest_out[DIGEST_TEXT_BYTES + 1U]
) {
  char without_digest[2048];
  int plain_length = snprintf(
    without_digest,
    sizeof(without_digest),
    "{\"committedAt\":\"%s\",\"directoryFsyncComplete\":true,\"publishedIdentityDigest\":\"%s\""
    ",\"schema\":\"writcraft.snapshot-receipt/v1\",\"snapshotId\":\"%s\""
    ",\"snapshotManifestDigest\":\"%s\",\"transactionId\":\"%s\"}",
    record->committed_at,
    record->published_identity_digest,
    record->snapshot_id,
    record->snapshot_manifest_digest,
    record->transaction_id
  );
  if (plain_length <= 0 || (size_t)plain_length >= sizeof(without_digest) ||
      !digest_domain("writcraft.snapshot-receipt/v1", without_digest, digest_out)) return false;
  int length = snprintf(
    out,
    capacity,
    "{\"committedAt\":\"%s\",\"directoryFsyncComplete\":true,\"publishedIdentityDigest\":\"%s\""
    ",\"receiptDigest\":\"%s\",\"schema\":\"writcraft.snapshot-receipt/v1\""
    ",\"snapshotId\":\"%s\",\"snapshotManifestDigest\":\"%s\",\"transactionId\":\"%s\"}\n",
    record->committed_at,
    record->published_identity_digest,
    digest_out,
    record->snapshot_id,
    record->snapshot_manifest_digest,
    record->transaction_id
  );
  return length > 0 && (size_t)length < capacity && (size_t)length <= MAX_RECORD_BYTES;
}

static bool create_control_record(
  const StorageBinding *storage,
  const char *name,
  const char *bytes,
  int *fd_out
) {
  size_t length = strlen(bytes);
  int fd = openat(
    storage->control_fd,
    name,
    O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC,
    0600
  );
  if (fd < 0) return false;
  struct stat value;
  bool valid = fstat(fd, &value) == 0 && S_ISREG(value.st_mode) && value.st_uid == geteuid() &&
    (value.st_mode & 0777) == 0600 && value.st_nlink == 1 && value.st_size == 0 &&
    full_write(fd, (const unsigned char *)bytes, length) && fsync(fd) == 0;
  if (!valid) {
    (void)close(fd);
    return false;
  }
  *fd_out = fd;
  return true;
}

static bool rewrite_control_record(
  const StorageBinding *storage,
  const char *name,
  int fd,
  const char *bytes
) {
  struct stat held;
  struct stat at_path;
  Identity held_identity;
  Identity path_identity;
  if (fstat(fd, &held) != 0 || fstatat(storage->control_fd, name, &at_path, AT_SYMLINK_NOFOLLOW) != 0 ||
      !identity_from_stat(&held, &held_identity) || !identity_from_stat(&at_path, &path_identity) ||
      !same_regular_identity(&held_identity, &path_identity)) return false;
  size_t length = strlen(bytes);
  return ftruncate(fd, 0) == 0 && lseek(fd, 0, SEEK_SET) == 0 &&
    full_write(fd, (const unsigned char *)bytes, length) && fsync(fd) == 0;
}

static bool read_regular_text_at(int parent_fd, const char *name, char *out, size_t capacity) {
  int fd = openat(parent_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat before;
  struct stat after;
  bool valid = fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_uid == geteuid() &&
    (before.st_mode & 0777) == 0600 && before.st_nlink == 1 && before.st_size > 0 &&
    (uintmax_t)before.st_size < capacity && before.st_size <= MAX_RECORD_BYTES &&
    pread_exact(fd, out, (size_t)before.st_size, 0U) &&
    fstat(fd, &after) == 0 && before.st_dev == after.st_dev && before.st_ino == after.st_ino &&
    before.st_size == after.st_size && before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
    before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec &&
    before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec &&
    before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec;
  if (valid) out[before.st_size] = '\0';
  (void)close(fd);
  return valid;
}

static bool path_absent_at(int parent_fd, const char *name) {
  struct stat value;
  errno = 0;
  return fstatat(parent_fd, name, &value, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
}

static bool read_owned_control_text(
  const StorageBinding *storage,
  const char *name,
  int fd,
  char *out,
  size_t capacity
) {
  struct stat before;
  struct stat at_path;
  struct stat after;
  Identity before_identity;
  Identity path_identity;
  Identity after_identity;
  bool valid = fstat(fd, &before) == 0 &&
    fstatat(storage->control_fd, name, &at_path, AT_SYMLINK_NOFOLLOW) == 0 &&
    identity_from_stat(&before, &before_identity) && identity_from_stat(&at_path, &path_identity) &&
    same_regular_identity(&before_identity, &path_identity) && before.st_uid == geteuid() &&
    (before.st_mode & 0777) == 0600 && before.st_nlink == 1 && before.st_size > 0 &&
    (uintmax_t)before.st_size < capacity && before.st_size <= MAX_RECORD_BYTES &&
    pread_exact(fd, out, (size_t)before.st_size, 0U) && fstat(fd, &after) == 0 &&
    identity_from_stat(&after, &after_identity) && same_regular_identity(&before_identity, &after_identity);
  if (valid) out[before.st_size] = '\0';
  return valid;
}

static bool parse_preparing_create_transaction(
  const char *bytes,
  CreateTransactionRecord *out
) {
  int consumed = 0;
  int matched = sscanf(
    bytes,
    "{\"createdAt\":\"%96[0-9TZ:+.-]\",\"lastErrorCode\":null,"
    "\"ownerGeneration\":%" SCNu64 ",\"projectInstanceId\":\"%33[a-z0-9_]\","
    "\"receiptDigest\":null,\"schema\":\"writcraft.snapshot-transaction/v1\","
    "\"snapshotId\":\"%128[A-Za-z0-9_-]\",\"snapshotManifestDigest\":\"%71[a-z0-9:]\","
    "\"stageIdentityDigest\":\"%71[a-z0-9:]\",\"state\":\"%15[A-Z]\","
    "\"transactionId\":\"%128[A-Za-z0-9_-]\",\"updatedAt\":\"%96[0-9TZ:+.-]\"}\n%n",
    out->created_at,
    &out->owner_generation,
    out->project_instance_id,
    out->snapshot_id,
    out->snapshot_manifest_digest,
    out->stage_identity_digest,
    out->state,
    out->transaction_id,
    out->updated_at,
    &consumed
  );
  return matched == 9 && consumed > 0 && bytes[consumed] == '\0' &&
    project_instance_id(out->project_instance_id) && valid_opaque(out->snapshot_id) &&
    valid_digest(out->snapshot_manifest_digest) && valid_digest(out->stage_identity_digest) &&
    strcmp(out->state, "PREPARING") == 0 && valid_opaque(out->transaction_id) &&
    safe_timestamp(out->created_at) && safe_timestamp(out->updated_at) &&
    out->owner_generation <= MAX_SAFE_INTEGER;
}

static bool parse_committed_create_transaction(
  const char *bytes,
  CreateTransactionRecord *out
) {
  int consumed = 0;
  int matched = sscanf(
    bytes,
    "{\"createdAt\":\"%96[0-9TZ:+.-]\",\"lastErrorCode\":null,"
    "\"ownerGeneration\":%" SCNu64 ",\"projectInstanceId\":\"%33[a-z0-9_]\","
    "\"receiptDigest\":\"%71[a-z0-9:]\",\"schema\":\"writcraft.snapshot-transaction/v1\","
    "\"snapshotId\":\"%128[A-Za-z0-9_-]\",\"snapshotManifestDigest\":\"%71[a-z0-9:]\","
    "\"stageIdentityDigest\":\"%71[a-z0-9:]\",\"state\":\"%15[A-Z]\","
    "\"transactionId\":\"%128[A-Za-z0-9_-]\",\"updatedAt\":\"%96[0-9TZ:+.-]\"}\n%n",
    out->created_at,
    &out->owner_generation,
    out->project_instance_id,
    out->receipt_digest,
    out->snapshot_id,
    out->snapshot_manifest_digest,
    out->stage_identity_digest,
    out->state,
    out->transaction_id,
    out->updated_at,
    &consumed
  );
  return matched == 10 && consumed > 0 && bytes[consumed] == '\0' &&
    project_instance_id(out->project_instance_id) && valid_opaque(out->snapshot_id) &&
    valid_digest(out->receipt_digest) && valid_digest(out->snapshot_manifest_digest) &&
    valid_digest(out->stage_identity_digest) && strcmp(out->state, "COMMITTED") == 0 &&
    valid_opaque(out->transaction_id) && safe_timestamp(out->created_at) &&
    safe_timestamp(out->updated_at) && out->owner_generation <= MAX_SAFE_INTEGER;
}

static bool parse_stage_reservation_json(const char *bytes, StageReservation *out) {
  int consumed = 0;
  int matched = sscanf(
    bytes,
    "{\"dev\":\"%" SCNuMAX "\",\"expectedBytes\":\"%" SCNu64
    "\",\"ino\":\"%" SCNuMAX "\",\"mode\":%" SCNuMAX
    ",\"nlink\":%" SCNuMAX ",\"recordDigest\":\"%71[a-z0-9:]\""
    ",\"schema\":\"writcraft.snapshot-stage-reservation/v1\",\"snapshotId\":\"%128[A-Za-z0-9_-]\""
    ",\"stageBasename\":\"%96[A-Za-z0-9._-]\",\"transactionId\":\"%128[A-Za-z0-9_-]\""
    ",\"uid\":%" SCNuMAX "}\n%n",
    &out->identity.dev,
    &out->expected_bytes,
    &out->identity.ino,
    &out->identity.mode,
    &out->identity.nlink,
    out->record_digest,
    out->snapshot_id,
    out->stage_basename,
    out->transaction_id,
    &out->identity.uid,
    &consumed
  );
  if (matched != 10 || consumed <= 0 || bytes[consumed] != '\0' ||
      !valid_digest(out->record_digest) || !valid_opaque(out->snapshot_id) ||
      !valid_stage_name(out->stage_basename) || !valid_opaque(out->transaction_id) ||
      out->expected_bytes > MAX_BUNDLE_BYTES || out->identity.uid != (uintmax_t)geteuid() ||
      out->identity.mode != 0600U || out->identity.nlink != 1U) return false;
  char canonical[4096];
  char digest[DIGEST_TEXT_BYTES + 1U];
  return make_stage_reservation_json(out, canonical, sizeof(canonical), digest) &&
    strcmp(digest, out->record_digest) == 0 && strcmp(canonical, bytes) == 0;
}

static bool reservation_matches_identity(
  const StageReservation *reservation,
  const Identity *identity
) {
  return reservation->identity.dev == identity->dev &&
    reservation->identity.ino == identity->ino &&
    reservation->identity.uid == identity->uid &&
    reservation->identity.mode == permission_mode(identity->mode) &&
    reservation->identity.nlink == identity->nlink &&
    S_ISREG((mode_t)identity->mode);
}

static bool parse_recovery_json(const char *bytes, RecoveryRecord *out) {
  int consumed = 0;
  int matched = sscanf(
    bytes,
    "{\"expectedManifestDigest\":\"%71[a-z0-9:]\",\"expectedPublishedIdentityDigest\":\"%71[a-z0-9:]\""
    ",\"markerDigest\":\"%71[a-z0-9:]\",\"schema\":\"writcraft.snapshot-recovery/v1\""
    ",\"snapshotId\":\"%128[A-Za-z0-9_-]\",\"state\":\"%15[A-Z]\""
    ",\"transactionId\":\"%128[A-Za-z0-9_-]\",\"updatedAt\":\"%96[0-9T:Z.+-]\"}\n%n",
    out->expected_manifest_digest,
    out->expected_published_identity_digest,
    out->marker_digest,
    out->snapshot_id,
    out->state,
    out->transaction_id,
    out->updated_at,
    &consumed
  );
  if (matched != 7 || consumed <= 0 || bytes[consumed] != '\0' ||
      !valid_digest(out->expected_manifest_digest) ||
      !valid_digest(out->expected_published_identity_digest) ||
      !valid_digest(out->marker_digest) || !valid_opaque(out->snapshot_id) ||
      !valid_opaque(out->transaction_id) || !safe_timestamp(out->updated_at) ||
      (strcmp(out->state, "PREPARING") != 0 && strcmp(out->state, "COMMITTED") != 0)) return false;
  char canonical[4096];
  char digest[DIGEST_TEXT_BYTES + 1U];
  return make_recovery_json(out, canonical, sizeof(canonical), digest) &&
    strcmp(digest, out->marker_digest) == 0 && strcmp(canonical, bytes) == 0;
}

static bool parse_receipt_json(const char *bytes, ReceiptRecord *out) {
  int consumed = 0;
  int matched = sscanf(
    bytes,
    "{\"committedAt\":\"%96[0-9T:Z.+-]\",\"directoryFsyncComplete\":true"
    ",\"publishedIdentityDigest\":\"%71[a-z0-9:]\",\"receiptDigest\":\"%71[a-z0-9:]\""
    ",\"schema\":\"writcraft.snapshot-receipt/v1\",\"snapshotId\":\"%128[A-Za-z0-9_-]\""
    ",\"snapshotManifestDigest\":\"%71[a-z0-9:]\",\"transactionId\":\"%128[A-Za-z0-9_-]\"}\n%n",
    out->committed_at,
    out->published_identity_digest,
    out->receipt_digest,
    out->snapshot_id,
    out->snapshot_manifest_digest,
    out->transaction_id,
    &consumed
  );
  if (matched != 6 || consumed <= 0 || bytes[consumed] != '\0' ||
      !safe_timestamp(out->committed_at) || !valid_digest(out->published_identity_digest) ||
      !valid_digest(out->receipt_digest) || !valid_digest(out->snapshot_manifest_digest) ||
      !valid_opaque(out->snapshot_id) || !valid_opaque(out->transaction_id)) return false;
  char canonical[4096];
  char digest[DIGEST_TEXT_BYTES + 1U];
  return make_receipt_json(out, canonical, sizeof(canonical), digest) &&
    strcmp(digest, out->receipt_digest) == 0 && strcmp(canonical, bytes) == 0;
}

static bool unlink_owned_control(const StorageBinding *storage, const char *name, int fd) {
  struct stat held;
  struct stat at_path;
  Identity held_identity;
  Identity path_identity;
  return fstat(fd, &held) == 0 &&
    fstatat(storage->control_fd, name, &at_path, AT_SYMLINK_NOFOLLOW) == 0 &&
    identity_from_stat(&held, &held_identity) && identity_from_stat(&at_path, &path_identity) &&
    same_regular_identity(&held_identity, &path_identity) &&
    unlinkat(storage->control_fd, name, 0) == 0;
}

static bool remove_owned_control(const StorageBinding *storage, const char *name, int fd) {
  return unlink_owned_control(storage, name, fd) && fsync(storage->control_fd) == 0;
}

static bool remove_recovery_marker(const StorageBinding *storage, const char *name, int fd) {
  if (!unlink_owned_control(storage, name, fd)) return false;
#ifdef WRITCRAFT_TEST_FAIL_AFTER_MARKER_UNLINK
  return false;
#else
  return fsync(storage->control_fd) == 0;
#endif
}

static bool open_valid_published(
  const StorageBinding *storage,
  const char *final_name,
  const char *expected_snapshot_id,
  const char *expected_manifest_digest,
  int *fd_out,
  Identity *identity_out,
  BundleInfo *bundle_out,
  char published_digest[DIGEST_TEXT_BYTES + 1U]
) {
  int fd = openat(
    storage->bundles_fd,
    final_name,
    O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC
  );
  if (fd < 0) return false;
  struct stat held;
  struct stat at_path;
  Identity held_identity;
  Identity path_identity;
  bool valid = fstat(fd, &held) == 0 && fstatat(
      storage->bundles_fd, final_name, &at_path, AT_SYMLINK_NOFOLLOW
    ) == 0 && identity_from_stat(&held, &held_identity) && identity_from_stat(&at_path, &path_identity) &&
    same_regular_identity(&held_identity, &path_identity) && held.st_uid == geteuid() &&
    (held.st_mode & 0777) == 0600 && held.st_nlink == 1 &&
    validate_bundle_fd(fd, expected_snapshot_id, expected_manifest_digest, bundle_out) &&
    compute_published_identity_digest(storage, final_name, &held_identity, bundle_out, published_digest);
  if (!valid) {
    (void)close(fd);
    return false;
  }
  *fd_out = fd;
  *identity_out = held_identity;
  return true;
}

static bool open_control_rw(const StorageBinding *storage, const char *name, int *fd_out) {
  int fd = openat(storage->control_fd, name, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat value;
  bool valid = fstat(fd, &value) == 0 && S_ISREG(value.st_mode) && value.st_uid == geteuid() &&
    (value.st_mode & 0777) == 0600 && value.st_nlink == 1 && value.st_size > 0 &&
    value.st_size <= MAX_RECORD_BYTES;
  if (!valid) {
    (void)close(fd);
    return false;
  }
  *fd_out = fd;
  return true;
}

static bool persist_committed_records(
  const StorageBinding *storage,
  const RecoveryRecord *preparing,
  const char *recovery_name,
  int marker_fd,
  const char *receipt_name,
  ReceiptRecord *receipt_out
) {
  ReceiptRecord receipt;
  memset(&receipt, 0, sizeof(receipt));
  memcpy(receipt.transaction_id, preparing->transaction_id, strlen(preparing->transaction_id) + 1U);
  memcpy(receipt.snapshot_id, preparing->snapshot_id, strlen(preparing->snapshot_id) + 1U);
  memcpy(
    receipt.published_identity_digest,
    preparing->expected_published_identity_digest,
    strlen(preparing->expected_published_identity_digest) + 1U
  );
  memcpy(
    receipt.snapshot_manifest_digest,
    preparing->expected_manifest_digest,
    strlen(preparing->expected_manifest_digest) + 1U
  );
  memcpy(receipt.committed_at, preparing->updated_at, strlen(preparing->updated_at) + 1U);
  char receipt_json[4096];
  if (!make_receipt_json(&receipt, receipt_json, sizeof(receipt_json), receipt.receipt_digest)) return false;
  int receipt_fd = -1;
  if (!create_control_record(storage, receipt_name, receipt_json, &receipt_fd)) {
    char existing[4096];
    ReceiptRecord parsed;
    memset(&parsed, 0, sizeof(parsed));
    if (!read_regular_text_at(storage->control_fd, receipt_name, existing, sizeof(existing)) ||
        !parse_receipt_json(existing, &parsed) || strcmp(existing, receipt_json) != 0) return false;
  } else {
    if (close(receipt_fd) != 0) return false;
  }
  if (fsync(storage->control_fd) != 0) return false;
  RecoveryRecord committed = *preparing;
  memcpy(committed.state, "COMMITTED", sizeof("COMMITTED"));
  char committed_json[4096];
  if (!make_recovery_json(
        &committed, committed_json, sizeof(committed_json), committed.marker_digest
      )) return false;
  int owned_marker = marker_fd;
  if (owned_marker < 0 && !open_control_rw(storage, recovery_name, &owned_marker)) return false;
  bool rewritten = rewrite_control_record(storage, recovery_name, owned_marker, committed_json);
  if (marker_fd < 0) (void)close(owned_marker);
  if (!rewritten || fsync(storage->control_fd) != 0) return false;
  *receipt_out = receipt;
  return true;
}

static void digest_hex(
  const unsigned char digest[CC_SHA256_DIGEST_LENGTH],
  char out[(CC_SHA256_DIGEST_LENGTH * 2U) + 1U]
) {
  static const char alphabet[] = "0123456789abcdef";
  for (size_t index = 0U; index < CC_SHA256_DIGEST_LENGTH; index += 1U) {
    out[index * 2U] = alphabet[digest[index] >> 4U];
    out[(index * 2U) + 1U] = alphabet[digest[index] & 0x0fU];
  }
  out[CC_SHA256_DIGEST_LENGTH * 2U] = '\0';
}

static bool finish_stage(char *line, RootBinding *root, StorageBinding *storage, Stage *stage) {
  char *fields[3];
  size_t count = 0U;
  if (!split_fields(line, fields, 3U, &count) || count != 3U || strcmp(fields[0], "F") != 0 ||
      !stage->active || stage->finalized || strcmp(fields[1], stage->transaction_id) != 0 ||
      !valid_digest(fields[2])) {
    return write_error('F', "PROTOCOL");
  }
  if (!revalidate_root(root) || !revalidate_storage(root, storage) || fsync(stage->fd) != 0) {
    return write_error('F', "IO");
  }
  Identity held_identity;
  unsigned char held_digest[CC_SHA256_DIGEST_LENGTH];
  BundleInfo bundle;
  if (!hash_fd_stable(stage->fd, &held_identity, held_digest) ||
      held_identity.size != stage->expected_bytes ||
      !stage_path_matches(storage, stage, NULL) ||
      !validate_bundle_fd(stage->fd, stage->snapshot_id, fields[2], &bundle)) {
    return write_error('F', "BUNDLE");
  }
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    return write_error('F', "IDENTITY");
  }
  int reopened = openat(
    storage->control_fd,
    stage->basename,
    O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC
  );
  Identity reopened_identity;
  unsigned char reopened_digest[CC_SHA256_DIGEST_LENGTH];
  bool valid = reopened >= 0 &&
    hash_fd_stable(reopened, &reopened_identity, reopened_digest) &&
    same_regular_identity(&held_identity, &reopened_identity) &&
    memcmp(held_digest, reopened_digest, CC_SHA256_DIGEST_LENGTH) == 0;
  if (reopened >= 0) (void)close(reopened);
  if (!valid) return write_error('F', "IDENTITY");
  memcpy(stage->file_sha256, held_digest, sizeof(stage->file_sha256));
  memcpy(stage->payload_sha256, bundle.payload_sha256, sizeof(stage->payload_sha256));
  memcpy(stage->snapshot_manifest_digest, fields[2], strlen(fields[2]) + 1U);
  stage->finalized = true;
  char hash[(CC_SHA256_DIGEST_LENGTH * 2U) + 1U];
  digest_hex(bundle.payload_sha256, hash);
  char response[512];
  int length = snprintf(
    response,
    sizeof(response),
    "F\tOK\t%s\t%s\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX
    "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\tsha256:%s\t%s\n",
    stage->transaction_id,
    stage->snapshot_id,
    held_identity.dev,
    held_identity.ino,
    held_identity.uid,
    permission_mode(held_identity.mode),
    held_identity.nlink,
    held_identity.size,
    hash,
    fields[2]
  );
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static bool cleanup_live_stage(StorageBinding *storage, Stage *stage) {
  Identity current;
  if (!stage_path_matches(storage, stage, &current)) return false;
  if (unlinkat(storage->control_fd, stage->basename, 0) != 0 || fsync(storage->control_fd) != 0) return false;
  struct stat absent;
  errno = 0;
  if (fstatat(storage->control_fd, stage->basename, &absent, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
    return false;
  }
  if (close(stage->fd) != 0) {
    stage->fd = -1;
    return false;
  }
  stage->fd = -1;
  stage->active = false;
  stage->finalized = false;
  return true;
}

static bool remove_live_reservation(StorageBinding *storage, Stage *stage) {
  if (stage->reservation_fd < 0 || stage->reservation_name[0] == '\0') return false;
  bool removed = remove_owned_control(
    storage, stage->reservation_name, stage->reservation_fd
  );
  bool closed = close(stage->reservation_fd) == 0;
  stage->reservation_fd = -1;
  return removed && closed;
}

static bool publish_stage(char *line, RootBinding *root, StorageBinding *storage, Stage *stage) {
  char *fields[4];
  size_t count = 0U;
  if (!split_fields(line, fields, 4U, &count) || count != 4U || strcmp(fields[0], "A") != 0 ||
      !stage->active || !stage->finalized || strcmp(fields[1], stage->transaction_id) != 0 ||
      !valid_final_name(fields[2]) || !safe_timestamp(fields[3])) {
    return write_error('A', "PROTOCOL") && false;
  }
  BundleInfo bundle;
  Identity stage_identity;
  unsigned char full_digest[CC_SHA256_DIGEST_LENGTH];
  if (!stage_path_matches(storage, stage, &stage_identity) ||
      !hash_fd_stable(stage->fd, &stage_identity, full_digest) ||
      memcmp(full_digest, stage->file_sha256, sizeof(full_digest)) != 0 ||
      !validate_bundle_fd(
        stage->fd, stage->snapshot_id, stage->snapshot_manifest_digest, &bundle
      )) {
    return write_error('A', "BUNDLE") && false;
  }
  char published_digest[DIGEST_TEXT_BYTES + 1U];
  if (!compute_published_identity_digest(
        storage, fields[2], &stage_identity, &bundle, published_digest
      )) return write_error('A', "IDENTITY") && false;
  char recovery_name[96];
  char receipt_name[96];
  if (!record_names(stage->transaction_id, recovery_name, receipt_name)) {
    return write_error('A', "PROTOCOL") && false;
  }
  RecoveryRecord marker;
  memset(&marker, 0, sizeof(marker));
  memcpy(marker.transaction_id, stage->transaction_id, strlen(stage->transaction_id) + 1U);
  memcpy(marker.snapshot_id, stage->snapshot_id, strlen(stage->snapshot_id) + 1U);
  memcpy(
    marker.expected_manifest_digest,
    stage->snapshot_manifest_digest,
    strlen(stage->snapshot_manifest_digest) + 1U
  );
  memcpy(marker.expected_published_identity_digest, published_digest, strlen(published_digest) + 1U);
  memcpy(marker.state, "PREPARING", sizeof("PREPARING"));
  memcpy(marker.updated_at, fields[3], strlen(fields[3]) + 1U);
  char marker_json[4096];
  if (!make_recovery_json(&marker, marker_json, sizeof(marker_json), marker.marker_digest)) {
    return write_error('A', "RECOVERY") && false;
  }
  int marker_fd = -1;
  if (!create_control_record(storage, recovery_name, marker_json, &marker_fd) ||
      fsync(storage->control_fd) != 0) {
    if (marker_fd >= 0) (void)close(marker_fd);
    return write_error('A', "RECOVERY") && false;
  }
#ifdef WRITCRAFT_TEST_CRASH_BEFORE_PUBLISH
  _exit(85);
#endif
  // The full root/storage rewalk and bundle revalidation are the last actions
  // before the atomic no-clobber publish.
  BundleInfo final_precheck;
  Identity final_stage_identity;
  bool ready = revalidate_root(root) && revalidate_storage(root, storage) &&
    stage_path_matches(storage, stage, &final_stage_identity) &&
    same_regular_identity(&stage_identity, &final_stage_identity) &&
    validate_bundle_fd(
      stage->fd, stage->snapshot_id, stage->snapshot_manifest_digest, &final_precheck
    ) && memcmp(final_precheck.payload_sha256, bundle.payload_sha256, CC_SHA256_DIGEST_LENGTH) == 0;
  if (!ready) {
    bool stage_removed = cleanup_live_stage(storage, stage);
    bool marker_removed = stage_removed && remove_recovery_marker(storage, recovery_name, marker_fd);
    (void)close(marker_fd);
    bool reservation_removed = marker_removed && remove_live_reservation(storage, stage);
    if (stage_removed && marker_removed && reservation_removed) {
      char response[256];
      int length = snprintf(response, sizeof(response), "A\tOK\t%s\tUNCOMMITTED\tPRECHECK\n", fields[1]);
      return length > 0 && (size_t)length < sizeof(response) && write_line(response);
    }
    return write_error('A', "UNKNOWN") && false;
  }
  if (renameatx_np(
        storage->control_fd,
        stage->basename,
        storage->bundles_fd,
        fields[2],
        RENAME_EXCL
      ) != 0) {
    const char *reason = errno == EEXIST ? "FINAL_EXISTS" : "RENAME_FAILED";
    bool stage_removed = cleanup_live_stage(storage, stage);
    bool marker_removed = stage_removed && remove_recovery_marker(storage, recovery_name, marker_fd);
    (void)close(marker_fd);
    bool reservation_removed = marker_removed && remove_live_reservation(storage, stage);
    if (stage_removed && marker_removed && reservation_removed && fsync(storage->bundles_fd) == 0) {
      char response[256];
      int length = snprintf(response, sizeof(response), "A\tOK\t%s\tUNCOMMITTED\t%s\n", fields[1], reason);
      return length > 0 && (size_t)length < sizeof(response) && write_line(response);
    }
    return write_error('A', "UNKNOWN") && false;
  }
#ifdef WRITCRAFT_TEST_CRASH_AFTER_PUBLISH
  _exit(86);
#endif
  int final_fd = -1;
  Identity published_identity;
  BundleInfo published_bundle;
  char actual_published_digest[DIGEST_TEXT_BYTES + 1U];
  unsigned char actual_full_digest[CC_SHA256_DIGEST_LENGTH];
  bool committed = open_valid_published(
      storage,
      fields[2],
      stage->snapshot_id,
      stage->snapshot_manifest_digest,
      &final_fd,
      &published_identity,
      &published_bundle,
      actual_published_digest
    ) && same_file_object(&stage_identity, &published_identity) &&
    strcmp(actual_published_digest, published_digest) == 0 &&
    hash_fd_stable(final_fd, &published_identity, actual_full_digest) &&
    memcmp(actual_full_digest, stage->file_sha256, sizeof(actual_full_digest)) == 0 &&
    fsync(storage->control_fd) == 0 && fsync(storage->bundles_fd) == 0;
  if (final_fd >= 0) (void)close(final_fd);
  ReceiptRecord receipt;
  if (committed) committed = persist_committed_records(
    storage, &marker, recovery_name, marker_fd, receipt_name, &receipt
  );
  (void)close(marker_fd);
  if (!committed) return write_error('A', "UNKNOWN") && false;
  if (close(stage->fd) != 0) {
    stage->fd = -1;
    return write_error('A', "UNKNOWN") && false;
  }
  stage->fd = -1;
  stage->active = false;
  stage->finalized = false;
  // COMMITTED receipt/recovery truth is already durable. Removing the
  // transitional reservation is cleanup only and may not downgrade COMMITTED.
  (void)remove_live_reservation(storage, stage);
#ifdef WRITCRAFT_TEST_DROP_COMMITTED_RESPONSE
  _exit(87);
#endif
  char response[512];
  int length = snprintf(
    response,
    sizeof(response),
    "A\tOK\t%s\tCOMMITTED\t%s\t%s\n",
    fields[1],
    published_digest,
    receipt.receipt_digest
  );
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

typedef enum {
  FRESH_COMMITTED_NONE = 0,
  FRESH_COMMITTED_EXACT = 1,
  FRESH_COMMITTED_IO = 2,
} FreshCommittedTruth;

static FreshCommittedTruth fresh_committed_create_truth(
  RootBinding *root,
  StorageBinding *storage,
  const char *transaction_id,
  const char *snapshot_id,
  const char *final_name,
  const char *transaction_name,
  const char *receipt_name,
  char published_digest_out[DIGEST_TEXT_BYTES + 1U],
  char receipt_digest_out[DIGEST_TEXT_BYTES + 1U]
) {
  int final_fd = -1;
  Identity final_identity;
  BundleInfo final_bundle;
  char published_digest[DIGEST_TEXT_BYTES + 1U];
  if (!open_valid_published(
        storage, final_name, snapshot_id, NULL, &final_fd,
        &final_identity, &final_bundle, published_digest
      )) {
    if (final_fd >= 0) (void)close(final_fd);
    return path_absent_at(storage->bundles_fd, final_name)
      ? FRESH_COMMITTED_NONE
      : FRESH_COMMITTED_IO;
  }
  char receipt_bytes[4096];
  ReceiptRecord receipt;
  memset(&receipt, 0, sizeof(receipt));
  char transaction_bytes[4096];
  CreateTransactionRecord transaction;
  memset(&transaction, 0, sizeof(transaction));
  bool exact = read_regular_text_at(
      storage->control_fd, receipt_name, receipt_bytes, sizeof(receipt_bytes)
    ) && parse_receipt_json(receipt_bytes, &receipt) &&
    read_regular_text_at(
      storage->control_fd, transaction_name, transaction_bytes, sizeof(transaction_bytes)
    ) && parse_committed_create_transaction(transaction_bytes, &transaction) &&
    strcmp(receipt.transaction_id, transaction_id) == 0 &&
    strcmp(receipt.snapshot_id, snapshot_id) == 0 &&
    strcmp(receipt.snapshot_manifest_digest, final_bundle.snapshot_manifest_digest) == 0 &&
    strcmp(receipt.published_identity_digest, published_digest) == 0 &&
    strcmp(transaction.transaction_id, transaction_id) == 0 &&
    strcmp(transaction.snapshot_id, snapshot_id) == 0 &&
    strcmp(transaction.snapshot_manifest_digest, final_bundle.snapshot_manifest_digest) == 0 &&
    strcmp(transaction.receipt_digest, receipt.receipt_digest) == 0 &&
    fsync(storage->control_fd) == 0 && fsync(storage->bundles_fd) == 0 &&
    revalidate_root(root) && revalidate_storage(root, storage);
  if (close(final_fd) != 0) exact = false;
  if (!exact) return FRESH_COMMITTED_IO;
  memcpy(published_digest_out, published_digest, strlen(published_digest) + 1U);
  memcpy(receipt_digest_out, receipt.receipt_digest, strlen(receipt.receipt_digest) + 1U);
  return FRESH_COMMITTED_EXACT;
}

static bool reconcile_create(char *line, RootBinding *root, StorageBinding *storage) {
  char *fields[6];
  size_t count = 0U;
  if (!split_fields(line, fields, 6U, &count) || count != 6U || strcmp(fields[0], "R") != 0 ||
      !valid_opaque(fields[1]) || !valid_opaque(fields[2]) || !valid_stage_name(fields[3]) ||
      !valid_final_name(fields[4]) || !safe_timestamp(fields[5])) {
    return write_error('R', "PROTOCOL") && false;
  }
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    return write_error('R', "ROOT") && false;
  }
  char recovery_name[96];
  char receipt_name[96];
  char stage_reservation_name[96];
  if (!record_names(fields[1], recovery_name, receipt_name) ||
      !reservation_name(fields[1], stage_reservation_name)) {
    return write_error('R', "PROTOCOL") && false;
  }
  int reservation_fd = -1;
  int final_fd = -1;
  int marker_fd = -1;
  int stage_fd = -1;
  int transaction_fd = -1;
  char production_transaction_name[96] = {0};
  char production_stage_name[96] = {0};
  char production_final_name[96] = {0};
  bool production_names_match = false;
  char reservation_bytes[4096];
  StageReservation reservation;
  memset(&reservation, 0, sizeof(reservation));
  bool has_reservation = open_control_rw(storage, stage_reservation_name, &reservation_fd) &&
    read_owned_control_text(
      storage, stage_reservation_name, reservation_fd, reservation_bytes, sizeof(reservation_bytes)
    ) && parse_stage_reservation_json(reservation_bytes, &reservation) &&
    strcmp(reservation.transaction_id, fields[1]) == 0 &&
    strcmp(reservation.snapshot_id, fields[2]) == 0 &&
    strcmp(reservation.stage_basename, fields[3]) == 0;
  bool reservation_absent = reservation_fd < 0 &&
    path_absent_at(storage->control_fd, stage_reservation_name);
  if (!has_reservation && !reservation_absent) goto unknown;

  char transaction_bytes[4096];
  CreateTransactionRecord transaction;
  memset(&transaction, 0, sizeof(transaction));
  production_names_match = production_names(
      fields[1], fields[2], production_transaction_name,
      production_stage_name, production_final_name
    ) && strcmp(production_stage_name, fields[3]) == 0 &&
    strcmp(production_final_name, fields[4]) == 0;
  bool has_production_transaction = production_names_match &&
    open_control_rw(storage, production_transaction_name, &transaction_fd) &&
    read_owned_control_text(
      storage, production_transaction_name, transaction_fd,
      transaction_bytes, sizeof(transaction_bytes)
    ) && parse_preparing_create_transaction(transaction_bytes, &transaction) &&
    strcmp(transaction.transaction_id, fields[1]) == 0 &&
    strcmp(transaction.snapshot_id, fields[2]) == 0;
  if (transaction_fd >= 0 && !has_production_transaction) {
    (void)close(transaction_fd);
    transaction_fd = -1;
  }

  char recovery_bytes[4096];
  RecoveryRecord marker;
  memset(&marker, 0, sizeof(marker));
  bool has_marker = read_regular_text_at(
      storage->control_fd, recovery_name, recovery_bytes, sizeof(recovery_bytes)
    ) && parse_recovery_json(recovery_bytes, &marker) &&
    strcmp(marker.transaction_id, fields[1]) == 0 && strcmp(marker.snapshot_id, fields[2]) == 0;
  bool marker_absent = !has_marker && path_absent_at(storage->control_fd, recovery_name);
  if (!has_marker && !marker_absent) goto unknown;
  char receipt_bytes[4096];
  ReceiptRecord receipt;
  memset(&receipt, 0, sizeof(receipt));
  bool has_receipt = read_regular_text_at(
      storage->control_fd, receipt_name, receipt_bytes, sizeof(receipt_bytes)
    ) && parse_receipt_json(receipt_bytes, &receipt) &&
    strcmp(receipt.transaction_id, fields[1]) == 0 && strcmp(receipt.snapshot_id, fields[2]) == 0;
  bool receipt_absent = !has_receipt && path_absent_at(storage->control_fd, receipt_name);
  if (!has_receipt && !receipt_absent) goto unknown;

  Identity final_identity;
  BundleInfo final_bundle;
  char published_digest[DIGEST_TEXT_BYTES + 1U];
  bool has_final = open_valid_published(
    storage, fields[4], fields[2], NULL, &final_fd, &final_identity, &final_bundle, published_digest
  );
  if (has_final) {
    if (has_reservation && !reservation_matches_identity(&reservation, &final_identity)) goto unknown;
    bool authority = (has_marker &&
        strcmp(marker.expected_manifest_digest, final_bundle.snapshot_manifest_digest) == 0 &&
        strcmp(marker.expected_published_identity_digest, published_digest) == 0) ||
      (has_receipt && strcmp(receipt.snapshot_manifest_digest, final_bundle.snapshot_manifest_digest) == 0 &&
        strcmp(receipt.published_identity_digest, published_digest) == 0);
    if (!authority || fsync(storage->bundles_fd) != 0) {
      goto unknown;
    }
    if (!has_marker) {
      // A receipt without its matching marker is committed evidence, but this
      // checkpoint does not synthesize a new marker at an unknown basename.
      if (!has_receipt) {
        goto unknown;
      }
    } else if (!has_receipt || strcmp(marker.state, "PREPARING") == 0) {
      if (strcmp(marker.state, "PREPARING") != 0) {
        goto unknown;
      }
      memcpy(marker.updated_at, fields[5], strlen(fields[5]) + 1U);
      if (!persist_committed_records(
            storage, &marker, recovery_name, -1, receipt_name, &receipt
          )) {
        goto unknown;
      }
      has_receipt = true;
    }
    if (close(final_fd) != 0) {
      final_fd = -1;
      goto unknown;
    }
    final_fd = -1;
    if (has_reservation) {
      char checked[4096];
      if (read_owned_control_text(
            storage, stage_reservation_name, reservation_fd, checked, sizeof(checked)
          ) && strcmp(checked, reservation_bytes) == 0) {
        (void)remove_owned_control(storage, stage_reservation_name, reservation_fd);
      }
      (void)close(reservation_fd);
      reservation_fd = -1;
    }
    if (!has_receipt || !revalidate_root(root) || !revalidate_storage(root, storage)) {
      goto unknown;
    }
    if (transaction_fd >= 0) {
      SealedCapture transaction_capture;
      memset(&transaction_capture, 0, sizeof(transaction_capture));
      memcpy(
        transaction_capture.transaction_id, transaction.transaction_id,
        strlen(transaction.transaction_id) + 1U
      );
      memcpy(
        transaction_capture.project_instance_id, transaction.project_instance_id,
        strlen(transaction.project_instance_id) + 1U
      );
      memcpy(
        transaction_capture.snapshot_id, transaction.snapshot_id,
        strlen(transaction.snapshot_id) + 1U
      );
      transaction_capture.owner_generation = transaction.owner_generation;
      memcpy(
        transaction_capture.created_at, transaction.created_at,
        strlen(transaction.created_at) + 1U
      );
      char committed_transaction_json[4096];
      if (!make_create_transaction_json(
            &transaction_capture, "COMMITTED", transaction.stage_identity_digest,
            final_bundle.snapshot_manifest_digest, receipt.receipt_digest, NULL,
            committed_transaction_json, sizeof(committed_transaction_json)
          ) || !rewrite_control_record(
            storage, production_transaction_name, transaction_fd, committed_transaction_json
          ) || fsync(storage->control_fd) != 0) goto unknown;
      (void)close(transaction_fd);
      transaction_fd = -1;
    }
    char response[512];
    int length = snprintf(
      response,
      sizeof(response),
      "R\tOK\t%s\tCOMMITTED\t%s\t%s\n",
      fields[1],
      published_digest,
      receipt.receipt_digest
    );
    return length > 0 && (size_t)length < sizeof(response) && write_line(response);
  }

  struct stat final_path;
  errno = 0;
  bool final_absent = fstatat(
      storage->bundles_fd, fields[4], &final_path, AT_SYMLINK_NOFOLLOW
    ) != 0 && errno == ENOENT;
  if (!final_absent || has_receipt || (!has_reservation && !has_production_transaction) ||
      (has_marker && strcmp(marker.state, "PREPARING") != 0)) goto unknown;
#ifdef WRITCRAFT_TEST_PAUSE_RECONCILE_AFTER_FINAL_ABSENT
  if (!test_sync_point("reconcile-final-absent")) goto unknown;
#endif

  stage_fd = openat(storage->control_fd, fields[3], O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  Stage recovered;
  memset(&recovered, 0, sizeof(recovered));
  recovered.fd = stage_fd;
  recovered.active = stage_fd >= 0;
  memcpy(recovered.basename, fields[3], strlen(fields[3]) + 1U);
  memcpy(recovered.transaction_id, fields[1], strlen(fields[1]) + 1U);
  memcpy(recovered.snapshot_id, fields[2], strlen(fields[2]) + 1U);
  if (stage_fd >= 0) {
    Identity stage_identity;
    bool stage_valid = stage_path_matches(storage, &recovered, &stage_identity);
    if (stage_valid && has_reservation) {
      stage_valid = reservation_matches_identity(&reservation, &stage_identity);
    } else if (stage_valid && has_production_transaction) {
      BundleInfo production_bundle;
      char payload_digest[DIGEST_TEXT_BYTES + 1U];
      char actual_stage_digest[DIGEST_TEXT_BYTES + 1U];
      stage_valid = validate_bundle_fd(
          stage_fd, fields[2], transaction.snapshot_manifest_digest, &production_bundle
        );
      if (stage_valid) {
        memcpy(payload_digest, "sha256:", 7U);
        digest_hex(production_bundle.payload_sha256, payload_digest + 7U);
        stage_valid = compute_stage_identity_digest(
            storage, &recovered, &stage_identity, payload_digest,
            transaction.snapshot_manifest_digest, actual_stage_digest
          ) && strcmp(actual_stage_digest, transaction.stage_identity_digest) == 0;
      }
    } else {
      stage_valid = false;
    }
    if (stage_valid && has_marker) {
      BundleInfo stage_bundle;
      char expected_published[DIGEST_TEXT_BYTES + 1U];
      stage_valid = validate_bundle_fd(
          stage_fd, fields[2], marker.expected_manifest_digest, &stage_bundle
        ) && compute_published_identity_digest(
          storage, fields[4], &stage_identity, &stage_bundle, expected_published
        ) && strcmp(expected_published, marker.expected_published_identity_digest) == 0;
    }
    if (!stage_valid || !cleanup_live_stage(storage, &recovered)) goto unknown;
    stage_fd = -1;
#ifdef WRITCRAFT_TEST_FAIL_AFTER_STAGE_CLEANUP
    goto unknown;
#endif
  } else if (!path_absent_at(storage->control_fd, fields[3])) {
    goto unknown;
  }
  // This fsync is required even when the stage is already absent: a prior R
  // may have unlinked it and failed before proving that directory mutation.
  if (fsync(storage->control_fd) != 0) goto unknown;

  if (has_marker) {
    char checked_marker[4096];
    if (!open_control_rw(storage, recovery_name, &marker_fd) ||
        !read_owned_control_text(
          storage, recovery_name, marker_fd, checked_marker, sizeof(checked_marker)
        ) || strcmp(checked_marker, recovery_bytes) != 0 ||
        !remove_recovery_marker(storage, recovery_name, marker_fd)) goto unknown;
    (void)close(marker_fd);
    marker_fd = -1;
  } else if (fsync(storage->control_fd) != 0) {
    goto unknown;
  }

  char terminal_uncommitted_json[4096];
  terminal_uncommitted_json[0] = '\0';
  bool wrote_uncommitted_transaction = false;
  if (has_reservation) {
    char checked_reservation[4096];
    if (!read_owned_control_text(
          storage,
          stage_reservation_name,
          reservation_fd,
          checked_reservation,
          sizeof(checked_reservation)
        ) || strcmp(checked_reservation, reservation_bytes) != 0 ||
        !remove_owned_control(storage, stage_reservation_name, reservation_fd)) goto unknown;
    (void)close(reservation_fd);
    reservation_fd = -1;
  } else {
    SealedCapture transaction_capture;
    memset(&transaction_capture, 0, sizeof(transaction_capture));
    memcpy(
      transaction_capture.transaction_id, transaction.transaction_id,
      strlen(transaction.transaction_id) + 1U
    );
    memcpy(
      transaction_capture.project_instance_id, transaction.project_instance_id,
      strlen(transaction.project_instance_id) + 1U
    );
    memcpy(
      transaction_capture.snapshot_id, transaction.snapshot_id,
      strlen(transaction.snapshot_id) + 1U
    );
    transaction_capture.owner_generation = transaction.owner_generation;
    memcpy(
      transaction_capture.created_at, transaction.created_at,
      strlen(transaction.created_at) + 1U
    );
    if (!make_create_transaction_json(
          &transaction_capture, "UNCOMMITTED", transaction.stage_identity_digest,
          transaction.snapshot_manifest_digest, NULL, "RECOVERED_UNCOMMITTED",
          terminal_uncommitted_json, sizeof(terminal_uncommitted_json)
        ) || !rewrite_control_record(
          storage, production_transaction_name, transaction_fd, terminal_uncommitted_json
        ) || fsync(storage->control_fd) != 0) goto unknown;
    wrote_uncommitted_transaction = true;
    (void)close(transaction_fd);
    transaction_fd = -1;
  }
  if (fsync(storage->bundles_fd) != 0 || !revalidate_root(root) ||
      !revalidate_storage(root, storage)) goto unknown;
  char fresh_published_digest[DIGEST_TEXT_BYTES + 1U];
  char fresh_receipt_digest[DIGEST_TEXT_BYTES + 1U];
  FreshCommittedTruth fresh = production_names_match
    ? fresh_committed_create_truth(
      root, storage, fields[1], fields[2], fields[4], production_transaction_name,
      receipt_name, fresh_published_digest, fresh_receipt_digest
    )
    : FRESH_COMMITTED_NONE;
  if (fresh == FRESH_COMMITTED_EXACT) {
    char committed_response[512];
    int committed_length = snprintf(
      committed_response,
      sizeof(committed_response),
      "R\tOK\t%s\tCOMMITTED\t%s\t%s\n",
      fields[1], fresh_published_digest, fresh_receipt_digest
    );
    return committed_length > 0 && (size_t)committed_length < sizeof(committed_response) &&
      write_line(committed_response);
  }
  if (fresh == FRESH_COMMITTED_IO ||
      !path_absent_at(storage->bundles_fd, fields[4]) ||
      !path_absent_at(storage->control_fd, receipt_name) ||
      !path_absent_at(storage->control_fd, recovery_name) ||
      !path_absent_at(storage->control_fd, fields[3]) ||
      !path_absent_at(storage->control_fd, stage_reservation_name)) goto unknown;
  if (production_names_match) {
    char terminal_transaction[4096];
    if (wrote_uncommitted_transaction) {
      if (!read_regular_text_at(
            storage->control_fd, production_transaction_name,
            terminal_transaction, sizeof(terminal_transaction)
          ) || strcmp(terminal_transaction, terminal_uncommitted_json) != 0) goto unknown;
    } else if (!path_absent_at(storage->control_fd, production_transaction_name)) {
      goto unknown;
    }
  }
  if (fsync(storage->control_fd) != 0 || fsync(storage->bundles_fd) != 0 ||
      !revalidate_root(root) || !revalidate_storage(root, storage)) goto unknown;
  char response[256];
  int length = snprintf(response, sizeof(response), "R\tOK\t%s\tUNCOMMITTED\n", fields[1]);
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);

unknown:
  if (stage_fd >= 0) (void)close(stage_fd);
  if (marker_fd >= 0) (void)close(marker_fd);
  if (final_fd >= 0) (void)close(final_fd);
  if (reservation_fd >= 0) (void)close(reservation_fd);
  if (transaction_fd >= 0) (void)close(transaction_fd);
  if (production_names_match) {
    char fresh_published_digest[DIGEST_TEXT_BYTES + 1U];
    char fresh_receipt_digest[DIGEST_TEXT_BYTES + 1U];
    FreshCommittedTruth fresh = fresh_committed_create_truth(
      root, storage, fields[1], fields[2], fields[4], production_transaction_name,
      receipt_name, fresh_published_digest, fresh_receipt_digest
    );
    if (fresh == FRESH_COMMITTED_EXACT) {
      char response[512];
      int length = snprintf(
        response,
        sizeof(response),
        "R\tOK\t%s\tCOMMITTED\t%s\t%s\n",
        fields[1], fresh_published_digest, fresh_receipt_digest
      );
      return length > 0 && (size_t)length < sizeof(response) && write_line(response);
    }
  }
  return write_error('R', "UNKNOWN") && false;
}

typedef struct {
  char snapshot_id[MAX_OPAQUE_BYTES + 1U];
  char manifest_digest[DIGEST_TEXT_BYTES + 1U];
  char published_digest[DIGEST_TEXT_BYTES + 1U];
  char receipt_digest[DIGEST_TEXT_BYTES + 1U];
  char final_name[96];
  uintmax_t size;
  Identity identity;
  BundleInfo bundle;
  unsigned char full_digest[CC_SHA256_DIGEST_LENGTH];
  int fd;
  char receipt_name[96];
  ReceiptRecord receipt;
  Identity receipt_identity;
  int receipt_fd;
} ListItem;

typedef struct {
  char item_digest[DIGEST_TEXT_BYTES + 1U];
  char reason[32];
} UnavailableListItem;

static void note_unavailable_list_item(
  UnavailableListItem items[MAX_UNAVAILABLE_DETAILS],
  size_t *detail_count,
  size_t *total_count,
  const char *name,
  const char *reason
) {
  *total_count += 1U;
  if (*detail_count >= MAX_UNAVAILABLE_DETAILS) return;
  UnavailableListItem *item = &items[(*detail_count)++];
  sha256_prefixed((const unsigned char *)name, strlen(name), item->item_digest);
  (void)snprintf(item->reason, sizeof(item->reason), "%s", reason);
}

static bool same_receipt_record(const ReceiptRecord *left, const ReceiptRecord *right) {
  return strcmp(left->transaction_id, right->transaction_id) == 0 &&
    strcmp(left->snapshot_id, right->snapshot_id) == 0 &&
    strcmp(left->published_identity_digest, right->published_identity_digest) == 0 &&
    strcmp(left->snapshot_manifest_digest, right->snapshot_manifest_digest) == 0 &&
    strcmp(left->committed_at, right->committed_at) == 0 &&
    strcmp(left->receipt_digest, right->receipt_digest) == 0;
}

static bool open_receipt_candidate(
  const StorageBinding *storage,
  const char *name,
  bool *exact_name_out,
  int *fd_out,
  Identity *identity_out,
  ReceiptRecord *receipt_out
) {
  int fd = openat(
    storage->control_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC
  );
  if (fd < 0) return false;
  char bytes[4096];
  char expected_recovery_name[96];
  char expected_receipt_name[96];
  ReceiptRecord receipt;
  Identity identity;
  struct stat held;
  memset(&receipt, 0, sizeof(receipt));
  *exact_name_out = false;
  bool valid = read_owned_control_text(storage, name, fd, bytes, sizeof(bytes)) &&
    parse_receipt_json(bytes, &receipt) && record_names(
      receipt.transaction_id, expected_recovery_name, expected_receipt_name
    ) && fstat(fd, &held) == 0 &&
    identity_from_stat(&held, &identity) && S_ISREG(held.st_mode) &&
    held.st_uid == geteuid() && (held.st_mode & 0777) == 0600 && held.st_nlink == 1;
  if (!valid) {
    (void)close(fd);
    return false;
  }
  *exact_name_out = strcmp(name, expected_receipt_name) == 0;
  *fd_out = fd;
  *identity_out = identity;
  *receipt_out = receipt;
  return true;
}

static bool open_receipt_for_bundle(
  const StorageBinding *storage,
  const BundleInfo *bundle,
  const char *published_digest,
  char name_out[96],
  int *fd_out,
  Identity *identity_out,
  ReceiptRecord *receipt_out
) {
  int duplicate = fcntl(storage->control_fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return false;
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    (void)close(duplicate);
    return false;
  }
  rewinddir(directory);
  bool found = false;
  bool rejected = false;
  int found_fd = -1;
  Identity found_identity;
  ReceiptRecord found_receipt;
  char found_name[96];
  struct dirent *entry = NULL;
  while ((entry = readdir(directory)) != NULL) {
    if (strncmp(entry->d_name, "receipt-", 8U) != 0 || strlen(entry->d_name) != 77U ||
        strcmp(entry->d_name + 72U, ".json") != 0) continue;
    int receipt_fd = -1;
    bool receipt_name_exact = false;
    Identity receipt_identity;
    ReceiptRecord receipt;
    memset(&receipt, 0, sizeof(receipt));
    if (open_receipt_candidate(
          storage,
          entry->d_name,
          &receipt_name_exact,
          &receipt_fd,
          &receipt_identity,
          &receipt
        ) && strcmp(receipt.snapshot_id, bundle->snapshot_id) == 0 &&
        strcmp(receipt.snapshot_manifest_digest, bundle->snapshot_manifest_digest) == 0 &&
        strcmp(receipt.published_identity_digest, published_digest) == 0) {
      if (!receipt_name_exact || found) {
        (void)close(receipt_fd);
        if (found_fd >= 0) (void)close(found_fd);
        found_fd = -1;
        found = false;
        rejected = true;
        break;
      }
      found_fd = receipt_fd;
      found_identity = receipt_identity;
      found_receipt = receipt;
      memcpy(found_name, entry->d_name, strlen(entry->d_name) + 1U);
      found = true;
    } else if (receipt_fd >= 0) {
      (void)close(receipt_fd);
    }
  }
  (void)closedir(directory);
  if (!found || rejected) return false;
  memcpy(name_out, found_name, strlen(found_name) + 1U);
  *fd_out = found_fd;
  *identity_out = found_identity;
  *receipt_out = found_receipt;
  return found;
}

static bool validate_receipt_uniqueness_terminal(
  const StorageBinding *storage,
  const char *expected_name,
  const Identity *expected_identity,
  const ReceiptRecord *expected_receipt,
  const BundleInfo *bundle,
  const char *published_digest
);

static bool validate_receipt_terminal(
  const StorageBinding *storage,
  const char *name,
  int held_fd,
  const Identity *expected_identity,
  const ReceiptRecord *expected_receipt,
  const BundleInfo *bundle,
  const char *published_digest
) {
  char held_bytes[4096];
  ReceiptRecord held_receipt;
  struct stat held_stat;
  Identity held_identity;
  memset(&held_receipt, 0, sizeof(held_receipt));
  if (!read_owned_control_text(
        storage, name, held_fd, held_bytes, sizeof(held_bytes)
      ) || !parse_receipt_json(held_bytes, &held_receipt) ||
      !same_receipt_record(&held_receipt, expected_receipt) ||
      fstat(held_fd, &held_stat) != 0 || !identity_from_stat(&held_stat, &held_identity) ||
      !same_regular_identity(expected_identity, &held_identity) ||
      strcmp(held_receipt.snapshot_id, bundle->snapshot_id) != 0 ||
      strcmp(held_receipt.snapshot_manifest_digest, bundle->snapshot_manifest_digest) != 0 ||
      strcmp(held_receipt.published_identity_digest, published_digest) != 0) return false;

  int reopened_fd = -1;
  bool reopened_name_exact = false;
  Identity reopened_identity;
  ReceiptRecord reopened_receipt;
  memset(&reopened_receipt, 0, sizeof(reopened_receipt));
  bool valid = open_receipt_candidate(
      storage,
      name,
      &reopened_name_exact,
      &reopened_fd,
      &reopened_identity,
      &reopened_receipt
    ) && reopened_name_exact && same_regular_identity(expected_identity, &reopened_identity) &&
    same_receipt_record(expected_receipt, &reopened_receipt) &&
    strcmp(reopened_receipt.snapshot_id, bundle->snapshot_id) == 0 &&
    strcmp(reopened_receipt.snapshot_manifest_digest, bundle->snapshot_manifest_digest) == 0 &&
    strcmp(reopened_receipt.published_identity_digest, published_digest) == 0;
  if (reopened_fd >= 0) (void)close(reopened_fd);
  return valid && validate_receipt_uniqueness_terminal(
    storage,
    name,
    expected_identity,
    expected_receipt,
    bundle,
    published_digest
  );
}

static bool validate_receipt_uniqueness_terminal(
  const StorageBinding *storage,
  const char *expected_name,
  const Identity *expected_identity,
  const ReceiptRecord *expected_receipt,
  const BundleInfo *bundle,
  const char *published_digest
) {
  int duplicate = fcntl(storage->control_fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return false;
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    (void)close(duplicate);
    return false;
  }
  rewinddir(directory);
  size_t matching = 0U;
  bool exact = true;
  struct dirent *entry = NULL;
  while ((entry = readdir(directory)) != NULL) {
    if (strncmp(entry->d_name, "receipt-", 8U) != 0 || strlen(entry->d_name) != 77U ||
        strcmp(entry->d_name + 72U, ".json") != 0) continue;
    int receipt_fd = -1;
    bool receipt_name_exact = false;
    Identity receipt_identity;
    ReceiptRecord receipt;
    memset(&receipt, 0, sizeof(receipt));
    if (!open_receipt_candidate(
          storage,
          entry->d_name,
          &receipt_name_exact,
          &receipt_fd,
          &receipt_identity,
          &receipt
        )) continue;
    bool matches = strcmp(receipt.snapshot_id, bundle->snapshot_id) == 0 &&
      strcmp(receipt.snapshot_manifest_digest, bundle->snapshot_manifest_digest) == 0 &&
      strcmp(receipt.published_identity_digest, published_digest) == 0;
    if (matches) {
      matching += 1U;
      if (!receipt_name_exact || strcmp(entry->d_name, expected_name) != 0 ||
          !same_regular_identity(&receipt_identity, expected_identity) ||
          !same_receipt_record(&receipt, expected_receipt)) exact = false;
    }
    (void)close(receipt_fd);
  }
  (void)closedir(directory);
  return exact && matching == 1U;
}

static int compare_list_item(const void *left, const void *right) {
  return strcmp(((const ListItem *)left)->snapshot_id, ((const ListItem *)right)->snapshot_id);
}

static int compare_unavailable_list_item(const void *left, const void *right) {
  return strcmp(
    ((const UnavailableListItem *)left)->item_digest,
    ((const UnavailableListItem *)right)->item_digest
  );
}

static bool validate_list_item_bundle_terminal(
  const StorageBinding *storage,
  const ListItem *item
) {
  Identity held_identity;
  unsigned char held_digest[CC_SHA256_DIGEST_LENGTH];
  if (!hash_fd_stable(item->fd, &held_identity, held_digest) ||
      !same_regular_identity(&item->identity, &held_identity) ||
      memcmp(item->full_digest, held_digest, sizeof(held_digest)) != 0) return false;
  int reopened_fd = -1;
  Identity reopened_identity;
  BundleInfo reopened_bundle;
  char reopened_published[DIGEST_TEXT_BYTES + 1U];
  Identity reopened_hashed_identity;
  unsigned char reopened_digest[CC_SHA256_DIGEST_LENGTH];
  bool valid = open_valid_published(
      storage, item->final_name, item->snapshot_id, item->manifest_digest,
      &reopened_fd, &reopened_identity, &reopened_bundle, reopened_published
    ) && same_regular_identity(&item->identity, &reopened_identity) &&
    strcmp(item->published_digest, reopened_published) == 0 &&
    memcmp(item->bundle.payload_sha256, reopened_bundle.payload_sha256,
      sizeof(item->bundle.payload_sha256)) == 0 &&
    hash_fd_stable(reopened_fd, &reopened_hashed_identity, reopened_digest) &&
    same_regular_identity(&item->identity, &reopened_hashed_identity) &&
    memcmp(item->full_digest, reopened_digest, sizeof(reopened_digest)) == 0;
  if (reopened_fd >= 0) (void)close(reopened_fd);
  return valid;
}

static bool list_committed(RootBinding *root, StorageBinding *storage) {
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    return write_error('L', "ROOT") && false;
  }
  int duplicate = fcntl(storage->bundles_fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return write_error('L', "IO") && false;
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    (void)close(duplicate);
    return write_error('L', "IO") && false;
  }
  rewinddir(directory);
  ListItem items[MAX_COMMITTED_SNAPSHOTS];
  UnavailableListItem unavailable_items[MAX_UNAVAILABLE_DETAILS];
  size_t item_count = 0U;
  size_t unavailable = 0U;
  size_t unavailable_detail_count = 0U;
  memset(items, 0, sizeof(items));
  for (size_t index = 0U; index < MAX_COMMITTED_SNAPSHOTS; index += 1U) {
    items[index].fd = -1;
    items[index].receipt_fd = -1;
  }
  struct dirent *entry = NULL;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (!valid_final_name(entry->d_name)) {
      note_unavailable_list_item(
        unavailable_items, &unavailable_detail_count, &unavailable,
        entry->d_name, "UNSAFE_NAME"
      );
      continue;
    }
    if (item_count >= MAX_COMMITTED_SNAPSHOTS) {
      note_unavailable_list_item(
        unavailable_items, &unavailable_detail_count, &unavailable,
        entry->d_name, "CAPACITY"
      );
      continue;
    }
    int fd = -1;
    Identity identity;
    BundleInfo bundle;
    char published_digest[DIGEST_TEXT_BYTES + 1U];
    ReceiptRecord receipt;
    Identity receipt_identity;
    int receipt_fd = -1;
    char receipt_name[96];
    memset(&receipt, 0, sizeof(receipt));
    bool bundle_valid = open_valid_published(
      storage, entry->d_name, NULL, NULL, &fd, &identity, &bundle, published_digest
    );
    bool receipt_valid = bundle_valid &&
      open_receipt_for_bundle(
        storage, &bundle, published_digest,
        receipt_name, &receipt_fd, &receipt_identity, &receipt
      );
    Identity final_identity;
    unsigned char final_digest[CC_SHA256_DIGEST_LENGTH];
    bool valid = receipt_valid && hash_fd_stable(fd, &final_identity, final_digest) &&
      same_regular_identity(&identity, &final_identity);
    if (!valid) {
      if (fd >= 0) (void)close(fd);
      if (receipt_fd >= 0) (void)close(receipt_fd);
      note_unavailable_list_item(
        unavailable_items, &unavailable_detail_count, &unavailable,
        entry->d_name, bundle_valid ? "RECEIPT_UNAVAILABLE" : "BUNDLE_UNAVAILABLE"
      );
      continue;
    }
    ListItem *item = &items[item_count++];
    memcpy(item->snapshot_id, bundle.snapshot_id, strlen(bundle.snapshot_id) + 1U);
    memcpy(item->manifest_digest, bundle.snapshot_manifest_digest, strlen(bundle.snapshot_manifest_digest) + 1U);
    memcpy(item->published_digest, published_digest, strlen(published_digest) + 1U);
    memcpy(item->receipt_digest, receipt.receipt_digest, strlen(receipt.receipt_digest) + 1U);
    memcpy(item->final_name, entry->d_name, strlen(entry->d_name) + 1U);
    item->size = identity.size;
    item->identity = identity;
    item->bundle = bundle;
    memcpy(item->full_digest, final_digest, sizeof(final_digest));
    item->fd = fd;
    memcpy(item->receipt_name, receipt_name, strlen(receipt_name) + 1U);
    item->receipt = receipt;
    item->receipt_identity = receipt_identity;
    item->receipt_fd = receipt_fd;
  }
  (void)closedir(directory);
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    return write_error('L', "ROOT") && false;
  }
#ifdef WRITCRAFT_TEST_PAUSE_COMMITTED_LIST_BEFORE_TERMINAL
  if (!test_sync_point("committed-list-before-terminal")) {
    for (size_t index = 0U; index < item_count; index += 1U) {
      if (items[index].fd >= 0) (void)close(items[index].fd);
      if (items[index].receipt_fd >= 0) (void)close(items[index].receipt_fd);
    }
    return write_error('L', "IO") && false;
  }
#endif
  size_t retained = 0U;
  for (size_t index = 0U; index < item_count; index += 1U) {
    bool bundle_terminal = validate_list_item_bundle_terminal(storage, &items[index]);
    bool receipt_terminal = bundle_terminal && validate_receipt_terminal(
      storage,
      items[index].receipt_name,
      items[index].receipt_fd,
      &items[index].receipt_identity,
      &items[index].receipt,
      &items[index].bundle,
      items[index].published_digest
    );
    if (items[index].fd >= 0) (void)close(items[index].fd);
    if (items[index].receipt_fd >= 0) (void)close(items[index].receipt_fd);
    items[index].fd = -1;
    items[index].receipt_fd = -1;
    if (!bundle_terminal || !receipt_terminal) {
      note_unavailable_list_item(
        unavailable_items, &unavailable_detail_count, &unavailable,
        items[index].final_name,
        bundle_terminal ? "RECEIPT_UNAVAILABLE" : "BUNDLE_UNAVAILABLE"
      );
      continue;
    }
    if (retained != index) items[retained] = items[index];
    retained += 1U;
  }
  item_count = retained;
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    return write_error('L', "ROOT") && false;
  }
  qsort(items, item_count, sizeof(items[0]), compare_list_item);
  qsort(
    unavailable_items,
    unavailable_detail_count,
    sizeof(unavailable_items[0]),
    compare_unavailable_list_item
  );
  for (size_t index = 0U; index < item_count; index += 1U) {
    char response[768];
    int length = snprintf(
      response,
      sizeof(response),
      "L\tITEM\t%s\t%s\t%s\t%s\t%" PRIuMAX "\n",
      items[index].snapshot_id,
      items[index].manifest_digest,
      items[index].published_digest,
      items[index].receipt_digest,
      items[index].size
    );
    if (length <= 0 || (size_t)length >= sizeof(response) || !write_line(response)) return false;
  }
  for (size_t index = 0U; index < unavailable_detail_count; index += 1U) {
    char response[256];
    int length = snprintf(
      response,
      sizeof(response),
      "L\tUNAVAILABLE\t%s\t%s\n",
      unavailable_items[index].item_digest,
      unavailable_items[index].reason
    );
    if (length <= 0 || (size_t)length >= sizeof(response) || !write_line(response)) return false;
  }
  char terminal[128];
  int terminal_length = snprintf(
    terminal, sizeof(terminal), "L\tOK\t%zu\t%zu\t%zu\n",
    item_count, unavailable, unavailable_detail_count
  );
  return terminal_length > 0 && (size_t)terminal_length < sizeof(terminal) && write_line(terminal);
}

static bool final_name_for_snapshot(const char *snapshot_id, char final_name[96]) {
  if (!valid_opaque(snapshot_id)) return false;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  char hex[(CC_SHA256_DIGEST_LENGTH * 2U) + 1U];
  CC_SHA256(snapshot_id, (CC_LONG)strlen(snapshot_id), digest);
  digest_hex(digest, hex);
  int length = snprintf(final_name, 96U, "bundle-%s.wcsb", hex);
  return length > 0 && length < 96;
}

static bool stream_committed_snapshot(
  char *line,
  RootBinding *root,
  StorageBinding *storage
) {
  char *fields[2];
  size_t count = 0U;
  if (!split_fields(line, fields, 2U, &count) || count != 2U ||
      strcmp(fields[0], "O") != 0 || !valid_opaque(fields[1])) {
    return write_error('O', "PROTOCOL") && false;
  }
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    return write_error('O', "ROOT") && false;
  }
  char final_name[96];
  if (!final_name_for_snapshot(fields[1], final_name)) {
    return write_error('O', "PROTOCOL") && false;
  }
  int fd = -1;
  Identity opened_identity;
  BundleInfo bundle;
  char published_digest[DIGEST_TEXT_BYTES + 1U];
  memset(&bundle, 0, sizeof(bundle));
  bool opened = open_valid_published(
    storage, final_name, fields[1], NULL,
    &fd, &opened_identity, &bundle, published_digest
  );
  if (!opened) {
    const char *code = path_absent_at(storage->bundles_fd, final_name)
      ? "NOT_FOUND"
      : "BUNDLE_UNAVAILABLE";
    return write_error('O', code) && false;
  }
  ReceiptRecord receipt;
  char receipt_name[96];
  int receipt_fd = -1;
  Identity receipt_identity;
  memset(&receipt, 0, sizeof(receipt));
  if (!open_receipt_for_bundle(
        storage, &bundle, published_digest,
        receipt_name, &receipt_fd, &receipt_identity, &receipt
      )) {
    (void)close(fd);
    return write_error('O', "RECEIPT_UNAVAILABLE") && false;
  }
  Identity before_stream;
  unsigned char before_digest[CC_SHA256_DIGEST_LENGTH];
  bool stable = hash_fd_stable(fd, &before_stream, before_digest) &&
    same_regular_identity(&opened_identity, &before_stream) &&
    revalidate_root(root) && revalidate_storage(root, storage);
  if (!stable) {
    (void)close(receipt_fd);
    (void)close(fd);
    return write_error('O', "IDENTITY") && false;
  }
  char payload_digest[DIGEST_TEXT_BYTES + 1U];
  memcpy(payload_digest, "sha256:", 7U);
  digest_hex(bundle.payload_sha256, payload_digest + 7U);
  char start[768];
  int start_length = snprintf(
    start,
    sizeof(start),
    "O\tSTART\t%s\t%s\t%s\t%s\t%s\t%" PRIuMAX "\n",
    bundle.snapshot_id,
    bundle.snapshot_manifest_digest,
    published_digest,
    receipt.receipt_digest,
    payload_digest,
    before_stream.size
  );
  if (start_length <= 0 || (size_t)start_length >= sizeof(start) || !write_line(start)) {
    (void)close(receipt_fd);
    (void)close(fd);
    return false;
  }

  unsigned char bytes[HASH_CHUNK_BYTES];
  char encoded[(HASH_CHUNK_BYTES * 2U) + 1U];
  char response[(HASH_CHUNK_BYTES * 2U) + 160U];
  uintmax_t offset = 0U;
  CC_SHA256_CTX streamed_context;
  CC_SHA256_Init(&streamed_context);
  static const char alphabet[] = "0123456789abcdef";
  while (offset < before_stream.size) {
    size_t requested = before_stream.size - offset > HASH_CHUNK_BYTES
      ? HASH_CHUNK_BYTES
      : (size_t)(before_stream.size - offset);
    if (!pread_exact(fd, bytes, requested, offset)) {
      (void)close(receipt_fd);
      (void)close(fd);
      return write_error('O', "IDENTITY") && false;
    }
    CC_SHA256_Update(&streamed_context, bytes, (CC_LONG)requested);
    for (size_t index = 0U; index < requested; index += 1U) {
      encoded[index * 2U] = alphabet[bytes[index] >> 4U];
      encoded[(index * 2U) + 1U] = alphabet[bytes[index] & 0x0fU];
    }
    encoded[requested * 2U] = '\0';
    int response_length = snprintf(
      response, sizeof(response), "O\tBYTES\t%" PRIuMAX "\t%s\n", offset, encoded
    );
    if (response_length <= 0 || (size_t)response_length >= sizeof(response) || !write_line(response)) {
      (void)close(receipt_fd);
      (void)close(fd);
      return false;
    }
    offset += requested;
  }
  unsigned char streamed_digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(streamed_digest, &streamed_context);
  struct stat after_stat;
  Identity after_stream;
  int path_fd = -1;
  Identity path_identity;
  BundleInfo after_bundle;
  char after_published_digest[DIGEST_TEXT_BYTES + 1U];
  bool final_valid = fstat(fd, &after_stat) == 0 &&
    identity_from_stat(&after_stat, &after_stream) &&
    same_regular_identity(&before_stream, &after_stream) &&
    memcmp(before_digest, streamed_digest, sizeof(before_digest)) == 0 &&
    open_valid_published(
      storage, final_name, fields[1], bundle.snapshot_manifest_digest,
      &path_fd, &path_identity, &after_bundle, after_published_digest
    ) && same_regular_identity(&after_stream, &path_identity) &&
    memcmp(after_bundle.payload_sha256, bundle.payload_sha256, sizeof(bundle.payload_sha256)) == 0 &&
    strcmp(after_published_digest, published_digest) == 0 &&
    revalidate_root(root) && revalidate_storage(root, storage);
#ifdef WRITCRAFT_TEST_PAUSE_COMMITTED_READ_BEFORE_TERMINAL
  if (final_valid && !test_sync_point("committed-read-before-terminal")) final_valid = false;
#endif
  Identity terminal_held_identity;
  unsigned char terminal_held_digest[CC_SHA256_DIGEST_LENGTH];
  int terminal_path_fd = -1;
  Identity terminal_path_identity;
  BundleInfo terminal_bundle;
  char terminal_published[DIGEST_TEXT_BYTES + 1U];
  Identity terminal_hashed_identity;
  unsigned char terminal_full_digest[CC_SHA256_DIGEST_LENGTH];
  bool terminal_bundle_valid = final_valid &&
    hash_fd_stable(fd, &terminal_held_identity, terminal_held_digest) &&
    same_regular_identity(&before_stream, &terminal_held_identity) &&
    memcmp(before_digest, terminal_held_digest, sizeof(before_digest)) == 0 &&
    open_valid_published(
      storage, final_name, fields[1], bundle.snapshot_manifest_digest,
      &terminal_path_fd, &terminal_path_identity, &terminal_bundle, terminal_published
    ) && same_regular_identity(&before_stream, &terminal_path_identity) &&
    memcmp(terminal_bundle.payload_sha256, bundle.payload_sha256,
      sizeof(bundle.payload_sha256)) == 0 &&
    strcmp(terminal_published, published_digest) == 0 &&
    hash_fd_stable(terminal_path_fd, &terminal_hashed_identity, terminal_full_digest) &&
    same_regular_identity(&before_stream, &terminal_hashed_identity) &&
    memcmp(before_digest, terminal_full_digest, sizeof(before_digest)) == 0;
  bool terminal_receipt_valid = terminal_bundle_valid && validate_receipt_terminal(
    storage,
    receipt_name,
    receipt_fd,
    &receipt_identity,
    &receipt,
    &bundle,
    published_digest
  );
  bool terminal_authority = terminal_receipt_valid &&
    revalidate_root(root) && revalidate_storage(root, storage);
  if (terminal_path_fd >= 0) (void)close(terminal_path_fd);
  if (path_fd >= 0) (void)close(path_fd);
  (void)close(receipt_fd);
  (void)close(fd);
  if (!terminal_authority) {
    return write_error('O', terminal_bundle_valid ? "RECEIPT_UNAVAILABLE" : "IDENTITY") && false;
  }
  char terminal[160];
  int terminal_length = snprintf(terminal, sizeof(terminal), "O\tOK\t%" PRIuMAX "\n", offset);
  return terminal_length > 0 && (size_t)terminal_length < sizeof(terminal) && write_line(terminal);
}

#ifdef WRITCRAFT_TEST_REPLACE_STAGE_BEFORE_CANCEL
static void inject_stage_replacement(const StorageBinding *storage, const Stage *stage) {
  static const char displaced[] = "attacker-displaced-stage-test";
  (void)unlinkat(storage->control_fd, displaced, 0);
  if (renameat(storage->control_fd, stage->basename, storage->control_fd, displaced) != 0) return;
  int replacement = openat(
    storage->control_fd,
    stage->basename,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    0600
  );
  if (replacement >= 0) {
    (void)full_write(replacement, (const unsigned char *)"replacement", 11U);
    (void)fsync(replacement);
    (void)close(replacement);
  }
  (void)fsync(storage->control_fd);
}
#endif

static bool cancel_stage(char *line, RootBinding *root, StorageBinding *storage, Stage *stage) {
  char *fields[2];
  size_t count = 0U;
  if (!split_fields(line, fields, 2U, &count) || count != 2U || strcmp(fields[0], "C") != 0 ||
      !stage->active || strcmp(fields[1], stage->transaction_id) != 0) {
    return write_error('C', "PROTOCOL") && false;
  }
#ifdef WRITCRAFT_TEST_REPLACE_STAGE_BEFORE_CANCEL
  inject_stage_replacement(storage, stage);
#endif
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    return write_error('C', "ROOT") && false;
  }
  Identity current;
  if (!stage_path_matches(storage, stage, &current)) {
    return write_error('C', "IDENTITY") && false;
  }
  if (stage->finalized) {
    Identity checked;
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    if (!hash_fd_stable(stage->fd, &checked, digest) ||
        !same_regular_identity(&current, &checked) ||
        memcmp(stage->file_sha256, digest, CC_SHA256_DIGEST_LENGTH) != 0) {
      return write_error('C', "IDENTITY") && false;
    }
  }
  if (!cleanup_live_stage(storage, stage)) return write_error('C', "UNKNOWN") && false;
  if (!remove_live_reservation(storage, stage)) return write_error('C', "UNKNOWN") && false;
  char response[384];
  int length = snprintf(
    response,
    sizeof(response),
    "C\tOK\t%s\tUNCOMMITTED\n",
    fields[1]
  );
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static bool production_names(
  const char *transaction_id,
  const char *snapshot_id,
  char transaction_name[96],
  char stage_name[96],
  char final_name[96]
) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  char transaction_hex[65];
  char snapshot_hex[65];
  CC_SHA256(transaction_id, (CC_LONG)strlen(transaction_id), digest);
  digest_hex(digest, transaction_hex);
  CC_SHA256(snapshot_id, (CC_LONG)strlen(snapshot_id), digest);
  digest_hex(digest, snapshot_hex);
  int a = snprintf(transaction_name, 96U, "transaction-%s.json", transaction_hex);
  int b = snprintf(stage_name, 96U, "stage-%s.wcsb", transaction_hex);
  int c = snprintf(final_name, 96U, "bundle-%s.wcsb", snapshot_hex);
  return a > 0 && a < 96 && b > 0 && b < 96 && c > 0 && c < 96;
}

static bool make_create_transaction_json(
  const SealedCapture *capture,
  const char *state,
  const char *stage_identity_digest,
  const char *manifest_digest,
  const char *receipt_digest,
  const char *last_error_code,
  char *out,
  size_t capacity
) {
  char stage_value[96];
  char receipt_value[96];
  char error_value[160];
  int stage_length = stage_identity_digest == NULL
    ? snprintf(stage_value, sizeof(stage_value), "null")
    : snprintf(stage_value, sizeof(stage_value), "\"%s\"", stage_identity_digest);
  int receipt_length = receipt_digest == NULL
    ? snprintf(receipt_value, sizeof(receipt_value), "null")
    : snprintf(receipt_value, sizeof(receipt_value), "\"%s\"", receipt_digest);
  int error_length = last_error_code == NULL
    ? snprintf(error_value, sizeof(error_value), "null")
    : snprintf(error_value, sizeof(error_value), "\"%s\"", last_error_code);
  if (stage_length <= 0 || receipt_length <= 0 || error_length <= 0 ||
      (size_t)stage_length >= sizeof(stage_value) ||
      (size_t)receipt_length >= sizeof(receipt_value) ||
      (size_t)error_length >= sizeof(error_value)) return false;
  int length = snprintf(
    out,
    capacity,
    "{\"createdAt\":\"%s\",\"lastErrorCode\":%s,\"ownerGeneration\":%" PRIu64
    ",\"projectInstanceId\":\"%s\",\"receiptDigest\":%s"
    ",\"schema\":\"writcraft.snapshot-transaction/v1\",\"snapshotId\":\"%s\""
    ",\"snapshotManifestDigest\":\"%s\",\"stageIdentityDigest\":%s"
    ",\"state\":\"%s\",\"transactionId\":\"%s\",\"updatedAt\":\"%s\"}\n",
    capture->created_at, error_value, capture->owner_generation, capture->project_instance_id,
    receipt_value, capture->snapshot_id, manifest_digest, stage_value, state,
    capture->transaction_id, capture->created_at
  );
  return length > 0 && (size_t)length < capacity && (size_t)length <= MAX_RECORD_BYTES;
}

static bool compute_stage_identity_digest(
  const StorageBinding *storage,
  const Stage *stage,
  const Identity *identity,
  const char *payload_digest,
  const char *manifest_digest,
  char out[DIGEST_TEXT_BYTES + 1U]
) {
  char basename_digest[DIGEST_TEXT_BYTES + 1U];
  sha256_prefixed(
    (const unsigned char *)stage->basename, strlen(stage->basename), basename_digest
  );
  char canonical[2048];
  int length = snprintf(
    canonical,
    sizeof(canonical),
    "{\"bundlePayloadSha256\":\"%s\",\"dev\":\"%" PRIuMAX
    "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX
    ",\"nlink\":%" PRIuMAX ",\"parentIdentityDigest\":\"%s\""
    ",\"schema\":\"writcraft.snapshot-stage-identity/v1\",\"size\":\"%" PRIuMAX
    "\",\"snapshotId\":\"%s\",\"snapshotManifestDigest\":\"%s\""
    ",\"stageBasenameSha256\":\"%s\",\"transactionId\":\"%s\",\"uid\":%" PRIuMAX "}",
    payload_digest, identity->dev, identity->ino, permission_mode(identity->mode), identity->nlink,
    storage->control_identity_digest, identity->size, stage->snapshot_id, manifest_digest,
    basename_digest, stage->transaction_id, identity->uid
  );
  return length > 0 && (size_t)length < sizeof(canonical) &&
    digest_domain("writcraft.snapshot-stage-identity/v1", canonical, out);
}

static bool settle_production_uncommitted(
  StorageBinding *storage,
  Stage *stage,
  const SealedCapture *capture,
  const char *transaction_name,
  int transaction_fd,
  const char *stage_digest,
  const char *manifest_digest,
  const char *recovery_name,
  int marker_fd,
  const char *error_code
) {
  bool stage_removed = !stage->active || cleanup_live_stage(storage, stage);
  bool marker_removed = marker_fd < 0;
  if (stage_removed && marker_fd >= 0) {
    marker_removed = remove_recovery_marker(storage, recovery_name, marker_fd);
  }
  char transaction_json[4096];
  bool rewritten = stage_removed && marker_removed && make_create_transaction_json(
      capture, "UNCOMMITTED", stage_digest, manifest_digest, NULL,
      error_code, transaction_json, sizeof(transaction_json)
    ) && rewrite_control_record(
      storage, transaction_name, transaction_fd, transaction_json
    ) && fsync(storage->control_fd) == 0;
  return rewritten;
}

typedef enum {
  PRODUCTION_CAPACITY_OK = 0,
  PRODUCTION_CAPACITY_EXCEEDED = 1,
  PRODUCTION_CAPACITY_BUSY = 2,
  PRODUCTION_CAPACITY_UNAVAILABLE = 3,
  PRODUCTION_CAPACITY_FINAL_EXISTS = 4,
} ProductionCapacityTruth;

static ProductionCapacityTruth production_capacity_guard(
  RootBinding *root,
  StorageBinding *storage,
  const char *final_name,
  uintmax_t prospective_size,
  int *lock_fd_out
) {
  *lock_fd_out = -1;
  int lock_fd = openat(
    storage->bundles_fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (lock_fd < 0) return PRODUCTION_CAPACITY_UNAVAILABLE;
  if (flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
    (void)close(lock_fd);
    return errno == EWOULDBLOCK || errno == EAGAIN
      ? PRODUCTION_CAPACITY_BUSY
      : PRODUCTION_CAPACITY_UNAVAILABLE;
  }
  struct stat lock_stat;
  Identity lock_identity;
  if (fstat(lock_fd, &lock_stat) != 0 || !identity_from_stat(&lock_stat, &lock_identity) ||
      !same_directory(&storage->bundles_identity, &lock_identity)) {
    (void)close(lock_fd);
    return PRODUCTION_CAPACITY_UNAVAILABLE;
  }

  int scan_fd = openat(
    storage->bundles_fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  if (scan_fd < 0) {
    (void)close(lock_fd);
    return PRODUCTION_CAPACITY_UNAVAILABLE;
  }
  DIR *directory = fdopendir(scan_fd);
  if (directory == NULL) {
    (void)close(scan_fd);
    (void)close(lock_fd);
    return PRODUCTION_CAPACITY_UNAVAILABLE;
  }

  size_t scanned = 0U;
  size_t committed_count = 0U;
  uintmax_t committed_bytes = 0U;
  ProductionCapacityTruth truth = PRODUCTION_CAPACITY_OK;
  struct dirent *entry = NULL;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    scanned += 1U;
    if (scanned > MAX_SCAN_ENTRIES || !valid_final_name(entry->d_name)) {
      truth = PRODUCTION_CAPACITY_UNAVAILABLE;
      break;
    }
    int fd = openat(
      storage->bundles_fd, entry->d_name,
      O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC
    );
    struct stat held;
    struct stat at_path;
    Identity held_identity;
    Identity path_identity;
    bool exact = fd >= 0 && fstat(fd, &held) == 0 &&
      fstatat(storage->bundles_fd, entry->d_name, &at_path, AT_SYMLINK_NOFOLLOW) == 0 &&
      identity_from_stat(&held, &held_identity) && identity_from_stat(&at_path, &path_identity) &&
      same_regular_identity(&held_identity, &path_identity) && S_ISREG(held.st_mode) &&
      held.st_uid == geteuid() && (held.st_mode & 0777) == 0600 && held.st_nlink == 1 &&
      held_identity.size <= MAX_BUNDLE_BYTES;
    if (fd >= 0) (void)close(fd);
    if (!exact) {
      truth = PRODUCTION_CAPACITY_UNAVAILABLE;
      break;
    }
    if (strcmp(entry->d_name, final_name) == 0) {
      truth = PRODUCTION_CAPACITY_FINAL_EXISTS;
      break;
    }
    if (held_identity.size > MAX_COMMITTED_PRIVATE_BYTES ||
        committed_bytes > MAX_COMMITTED_PRIVATE_BYTES - held_identity.size) {
      truth = PRODUCTION_CAPACITY_EXCEEDED;
      break;
    }
    committed_bytes += held_identity.size;
    committed_count += 1U;
  }
  (void)closedir(directory);
  if (truth == PRODUCTION_CAPACITY_OK &&
      (!revalidate_root(root) || !revalidate_storage(root, storage))) {
    truth = PRODUCTION_CAPACITY_UNAVAILABLE;
  }
  if (truth == PRODUCTION_CAPACITY_OK &&
      (committed_count >= MAX_COMMITTED_SNAPSHOTS ||
       prospective_size > MAX_COMMITTED_PRIVATE_BYTES ||
       prospective_size > MAX_COMMITTED_PRIVATE_BYTES - committed_bytes)) {
    truth = PRODUCTION_CAPACITY_EXCEEDED;
  }
  if (truth == PRODUCTION_CAPACITY_OK) {
    *lock_fd_out = lock_fd;
    return truth;
  }
  (void)close(lock_fd);
  return truth;
}

static bool finish_production_capture(
  char *line,
  RootBinding *root,
  StorageBinding *storage,
  Stage *stage,
  SealedCapture *capture
) {
  char *fields[2];
  size_t count = 0U;
  if (!split_fields(line, fields, 2U, &count) || count != 2U || strcmp(fields[0], "B") != 0 ||
      !capture->active || stage->active || capture->token_pass_bytes == NULL ||
      strcmp(fields[1], capture->transaction_id) != 0) {
    return write_error('B', "PROTOCOL") && false;
  }
  ByteBuffer bundle = {0};
  char manifest_digest[DIGEST_TEXT_BYTES + 1U];
  char payload_digest[DIGEST_TEXT_BYTES + 1U];
  if (!build_snapshot_bundle(root, capture, &bundle, manifest_digest, payload_digest)) {
    free_byte_buffer(&bundle);
    return write_error('B', "BUNDLE") && false;
  }
  char transaction_name[96];
  char stage_name[96];
  char final_name[96];
  if (!production_names(
        capture->transaction_id, capture->snapshot_id,
        transaction_name, stage_name, final_name
      ) || !revalidate_root(root) || !revalidate_storage(root, storage)) {
    free_byte_buffer(&bundle);
    return write_error('B', "ROOT") && false;
  }
  char transaction_json[4096];
  if (!make_create_transaction_json(
        capture, "PREPARING", NULL, manifest_digest, NULL, NULL,
        transaction_json, sizeof(transaction_json)
      )) {
    free_byte_buffer(&bundle);
    return write_error('B', "TRANSACTION") && false;
  }
  int transaction_fd = -1;
  if (!create_control_record(storage, transaction_name, transaction_json, &transaction_fd) ||
      fsync(storage->control_fd) != 0) {
    if (transaction_fd >= 0) (void)close(transaction_fd);
    free_byte_buffer(&bundle);
    return write_error('B', "UNKNOWN") && false;
  }

  int stage_fd = openat(
    storage->control_fd, stage_name,
    O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600
  );
  if (stage_fd < 0) {
    const char *code = errno == EEXIST ? "STAGE_EXISTS" : "STAGE_IO";
    char settled[4096];
    bool known = make_create_transaction_json(
        capture, "UNCOMMITTED", NULL, manifest_digest, NULL, code,
        settled, sizeof(settled)
      ) && rewrite_control_record(storage, transaction_name, transaction_fd, settled) &&
      fsync(storage->control_fd) == 0;
    (void)close(transaction_fd);
    free_byte_buffer(&bundle);
    if (!known) return write_error('B', "UNKNOWN") && false;
    char response[512];
    int length = snprintf(
      response, sizeof(response), "B\tOK\t%s\tUNCOMMITTED\t%s\t%s\n",
      capture->transaction_id, manifest_digest, code
    );
    return length > 0 && (size_t)length < sizeof(response) && write_line(response);
  }
  memset(stage, 0, sizeof(*stage));
  stage->fd = stage_fd;
  stage->reservation_fd = -1;
  stage->active = true;
  memcpy(stage->transaction_id, capture->transaction_id, strlen(capture->transaction_id) + 1U);
  memcpy(stage->snapshot_id, capture->snapshot_id, strlen(capture->snapshot_id) + 1U);
  memcpy(stage->basename, stage_name, strlen(stage_name) + 1U);
  stage->expected_bytes = bundle.length;
  struct stat initial_stat;
  Identity initial_identity;
  bool stage_created = fstat(stage_fd, &initial_stat) == 0 &&
    identity_from_stat(&initial_stat, &initial_identity) && S_ISREG(initial_stat.st_mode) &&
    initial_stat.st_uid == geteuid() && (initial_stat.st_mode & 0777) == 0600 &&
    initial_stat.st_nlink == 1 && initial_stat.st_size == 0;
  if (stage_created) stage->initial_identity = initial_identity;
  bool written = stage_created && full_write(stage_fd, bundle.bytes, bundle.length) &&
    fsync(stage_fd) == 0 && stage_path_matches(storage, stage, NULL);
  BundleInfo staged_bundle;
  Identity staged_identity;
  unsigned char staged_full_digest[CC_SHA256_DIGEST_LENGTH];
  written = written && hash_fd_stable(stage_fd, &staged_identity, staged_full_digest) &&
    staged_identity.size == bundle.length &&
    validate_bundle_fd(stage_fd, capture->snapshot_id, manifest_digest, &staged_bundle);
  free_byte_buffer(&bundle);
  char stage_digest[DIGEST_TEXT_BYTES + 1U];
  bool staged = written && compute_stage_identity_digest(
    storage, stage, &staged_identity, payload_digest, manifest_digest, stage_digest
  );
  if (staged) {
    memcpy(stage->file_sha256, staged_full_digest, sizeof(staged_full_digest));
    memcpy(stage->payload_sha256, staged_bundle.payload_sha256, sizeof(stage->payload_sha256));
    memcpy(stage->snapshot_manifest_digest, manifest_digest, strlen(manifest_digest) + 1U);
    stage->finalized = true;
    staged = make_create_transaction_json(
        capture, "PREPARING", stage_digest, manifest_digest, NULL, NULL,
        transaction_json, sizeof(transaction_json)
      ) && rewrite_control_record(storage, transaction_name, transaction_fd, transaction_json) &&
      fsync(storage->control_fd) == 0;
  }
  if (!staged) {
    bool known = settle_production_uncommitted(
      storage, stage, capture, transaction_name, transaction_fd,
      written ? stage_digest : NULL, manifest_digest, "", -1, "STAGE_IO"
    );
    (void)close(transaction_fd);
    if (!known) return write_error('B', "UNKNOWN") && false;
    char response[512];
    int length = snprintf(
      response, sizeof(response), "B\tOK\t%s\tUNCOMMITTED\t%s\tSTAGE_IO\n",
      capture->transaction_id, manifest_digest
    );
    return length > 0 && (size_t)length < sizeof(response) && write_line(response);
  }

  char published_digest[DIGEST_TEXT_BYTES + 1U];
  if (!compute_published_identity_digest(
        storage, final_name, &staged_identity, &staged_bundle, published_digest
      )) {
    (void)close(transaction_fd);
    return write_error('B', "UNKNOWN") && false;
  }
  char recovery_name[96];
  char receipt_name[96];
  RecoveryRecord marker;
  memset(&marker, 0, sizeof(marker));
  if (!record_names(capture->transaction_id, recovery_name, receipt_name)) {
    (void)close(transaction_fd);
    return write_error('B', "UNKNOWN") && false;
  }
  memcpy(marker.transaction_id, capture->transaction_id, strlen(capture->transaction_id) + 1U);
  memcpy(marker.snapshot_id, capture->snapshot_id, strlen(capture->snapshot_id) + 1U);
  memcpy(marker.expected_manifest_digest, manifest_digest, strlen(manifest_digest) + 1U);
  memcpy(marker.expected_published_identity_digest, published_digest, strlen(published_digest) + 1U);
  memcpy(marker.state, "PREPARING", sizeof("PREPARING"));
  memcpy(marker.updated_at, capture->created_at, strlen(capture->created_at) + 1U);
  char marker_json[4096];
  int marker_fd = -1;
  bool marker_ready = make_recovery_json(
      &marker, marker_json, sizeof(marker_json), marker.marker_digest
    ) && create_control_record(storage, recovery_name, marker_json, &marker_fd) &&
    fsync(storage->control_fd) == 0;
  if (!marker_ready) {
    if (marker_fd >= 0) (void)close(marker_fd);
    (void)close(transaction_fd);
    return write_error('B', "UNKNOWN") && false;
  }
#ifdef WRITCRAFT_TEST_CRASH_PRODUCTION_BEFORE_PUBLISH
  _exit(89);
#endif

  int capacity_lock_fd = -1;
  ProductionCapacityTruth capacity = production_capacity_guard(
    root, storage, final_name, staged_identity.size, &capacity_lock_fd
  );
  if (capacity != PRODUCTION_CAPACITY_OK) {
    const char *code = capacity == PRODUCTION_CAPACITY_EXCEEDED
      ? "SNAPSHOT_CAPACITY_EXCEEDED"
      : capacity == PRODUCTION_CAPACITY_BUSY
        ? "SNAPSHOT_CAPACITY_BUSY"
        : capacity == PRODUCTION_CAPACITY_FINAL_EXISTS
          ? "FINAL_EXISTS"
          : "SNAPSHOT_CAPACITY_UNAVAILABLE";
    bool known = settle_production_uncommitted(
      storage, stage, capture, transaction_name, transaction_fd,
      stage_digest, manifest_digest, recovery_name, marker_fd, code
    );
    (void)close(marker_fd);
    (void)close(transaction_fd);
    if (!known) return write_error('B', "UNKNOWN") && false;
    char response[512];
    int length = snprintf(
      response, sizeof(response), "B\tOK\t%s\tUNCOMMITTED\t%s\t%s\n",
      capture->transaction_id, manifest_digest, code
    );
    return length > 0 && (size_t)length < sizeof(response) && write_line(response);
  }

  // This exact full source rewalk/re-read is deliberately the final operation
  // before atomic no-clobber publish. No time window is used as authority.
  if (!recheck_capture_sources(root, storage, capture)) {
    bool known = settle_production_uncommitted(
      storage, stage, capture, transaction_name, transaction_fd,
      stage_digest, manifest_digest, recovery_name, marker_fd, "SOURCE_STALE"
    );
    (void)close(capacity_lock_fd);
    (void)close(marker_fd);
    (void)close(transaction_fd);
    if (!known) return write_error('B', "UNKNOWN") && false;
    char response[512];
    int length = snprintf(
      response, sizeof(response), "B\tOK\t%s\tUNCOMMITTED\t%s\tSOURCE_STALE\n",
      capture->transaction_id, manifest_digest
    );
    return length > 0 && (size_t)length < sizeof(response) && write_line(response);
  }
#ifdef WRITCRAFT_TEST_PAUSE_PRODUCTION_BEFORE_RENAME
  if (!test_sync_point("production-before-rename")) {
    (void)close(capacity_lock_fd);
    (void)close(marker_fd);
    (void)close(transaction_fd);
    return write_error('B', "UNKNOWN") && false;
  }
#endif
  if (renameatx_np(
        storage->control_fd, stage_name, storage->bundles_fd, final_name, RENAME_EXCL
      ) != 0) {
    const char *code = errno == EEXIST ? "FINAL_EXISTS" : "RENAME_FAILED";
    bool known = settle_production_uncommitted(
      storage, stage, capture, transaction_name, transaction_fd,
      stage_digest, manifest_digest, recovery_name, marker_fd, code
    );
    (void)close(capacity_lock_fd);
    (void)close(marker_fd);
    (void)close(transaction_fd);
    if (!known) return write_error('B', "UNKNOWN") && false;
    char response[512];
    int length = snprintf(
      response, sizeof(response), "B\tOK\t%s\tUNCOMMITTED\t%s\t%s\n",
      capture->transaction_id, manifest_digest, code
    );
    return length > 0 && (size_t)length < sizeof(response) && write_line(response);
  }

  int final_fd = -1;
  Identity final_identity;
  BundleInfo final_bundle;
  char final_published_digest[DIGEST_TEXT_BYTES + 1U];
  unsigned char final_full_digest[CC_SHA256_DIGEST_LENGTH];
  bool committed = open_valid_published(
      storage, final_name, capture->snapshot_id, manifest_digest,
      &final_fd, &final_identity, &final_bundle, final_published_digest
    ) && same_file_object(&staged_identity, &final_identity) &&
    strcmp(final_published_digest, published_digest) == 0 &&
    hash_fd_stable(final_fd, &final_identity, final_full_digest) &&
    memcmp(final_full_digest, staged_full_digest, sizeof(final_full_digest)) == 0 &&
    fsync(storage->control_fd) == 0 && fsync(storage->bundles_fd) == 0;
  if (final_fd >= 0) (void)close(final_fd);
  ReceiptRecord receipt;
  if (committed) committed = persist_committed_records(
    storage, &marker, recovery_name, marker_fd, receipt_name, &receipt
  );
  if (committed) committed = make_create_transaction_json(
      capture, "COMMITTED", stage_digest, manifest_digest, receipt.receipt_digest, NULL,
      transaction_json, sizeof(transaction_json)
    ) && rewrite_control_record(storage, transaction_name, transaction_fd, transaction_json) &&
    fsync(storage->control_fd) == 0;
  (void)close(marker_fd);
  (void)close(transaction_fd);
  (void)close(capacity_lock_fd);
  if (!committed) return write_error('B', "UNKNOWN") && false;
  (void)close(stage->fd);
  stage->fd = -1;
  stage->active = false;
  stage->finalized = false;
#ifdef WRITCRAFT_TEST_DROP_PRODUCTION_COMMITTED_RESPONSE
  _exit(88);
#endif
  char response[768];
  int length = snprintf(
    response, sizeof(response), "B\tOK\t%s\tCOMMITTED\t%s\t%s\t%s\n",
    capture->transaction_id, manifest_digest, published_digest, receipt.receipt_digest
  );
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static bool delete_record_names(
  const char *transaction_id,
  char transaction_name[96],
  char recovery_name[96],
  char receipt_name[96],
  char quarantine_prefix[64]
) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  char hex[65];
  CC_SHA256(transaction_id, (CC_LONG)strlen(transaction_id), digest);
  digest_hex(digest, hex);
  int a = snprintf(transaction_name, 96U, "delete-transaction-%s.json", hex);
  int b = snprintf(recovery_name, 96U, "delete-recovery-%s.json", hex);
  int c = snprintf(receipt_name, 96U, "delete-receipt-%s.json", hex);
  int d = snprintf(quarantine_prefix, 64U, "delete-q-%.32s-", hex);
  return a > 0 && a < 96 && b > 0 && b < 96 && c > 0 && c < 96 &&
    d > 0 && d < 64;
}

static bool random_quarantine_name(
  const char *prefix,
  char out[96]
) {
  unsigned char random_bytes[16];
  char random_hex[33];
  arc4random_buf(random_bytes, sizeof(random_bytes));
  static const char alphabet[] = "0123456789abcdef";
  for (size_t index = 0U; index < sizeof(random_bytes); index += 1U) {
    random_hex[index * 2U] = alphabet[(random_bytes[index] >> 4U) & 0x0fU];
    random_hex[(index * 2U) + 1U] = alphabet[random_bytes[index] & 0x0fU];
  }
  random_hex[32] = '\0';
  int length = snprintf(out, 96U, "%s%s.wcsb", prefix, random_hex);
  return length > 0 && length < 96;
}

static bool make_delete_transaction_json(
  const DeleteTransactionRecord *record,
  char *out,
  size_t capacity
) {
  char quarantine[96];
  char receipt[96];
  char error[160];
  int a = record->quarantine_identity_digest[0] == '\0'
    ? snprintf(quarantine, sizeof(quarantine), "null")
    : snprintf(quarantine, sizeof(quarantine), "\"%s\"", record->quarantine_identity_digest);
  int b = record->receipt_digest[0] == '\0'
    ? snprintf(receipt, sizeof(receipt), "null")
    : snprintf(receipt, sizeof(receipt), "\"%s\"", record->receipt_digest);
  int c = record->last_error_code[0] == '\0'
    ? snprintf(error, sizeof(error), "null")
    : snprintf(error, sizeof(error), "\"%s\"", record->last_error_code);
  if (a <= 0 || b <= 0 || c <= 0 || (size_t)a >= sizeof(quarantine) ||
      (size_t)b >= sizeof(receipt) || (size_t)c >= sizeof(error)) return false;
  int length = snprintf(
    out,
    capacity,
    "{\"createdAt\":\"%s\",\"lastErrorCode\":%s,\"ownerGeneration\":%" PRIu64
    ",\"projectInstanceId\":\"%s\",\"quarantineIdentityDigest\":%s,\"receiptDigest\":%s"
    ",\"schema\":\"writcraft.snapshot-delete-transaction/v1\",\"snapshotId\":\"%s\""
    ",\"snapshotManifestDigest\":\"%s\",\"sourceIdentityDigest\":\"%s\""
    ",\"state\":\"%s\",\"transactionId\":\"%s\",\"updatedAt\":\"%s\"}\n",
    record->created_at,
    error,
    record->owner_generation,
    record->project_instance_id,
    quarantine,
    receipt,
    record->snapshot_id,
    record->snapshot_manifest_digest,
    record->source_identity_digest,
    record->state,
    record->transaction_id,
    record->updated_at
  );
  return length > 0 && (size_t)length < capacity && (size_t)length <= MAX_RECORD_BYTES;
}

static bool parse_delete_transaction_json(
  const char *bytes,
  DeleteTransactionRecord *out
) {
  DeleteTransactionRecord parsed;
  memset(&parsed, 0, sizeof(parsed));
  char quarantine[96];
  char receipt[96];
  char error[160];
  int consumed = 0;
  int matched = sscanf(
    bytes,
    "{\"createdAt\":\"%96[0-9TZ:+.-]\",\"lastErrorCode\":%159[^,],"
    "\"ownerGeneration\":%" SCNu64 ",\"projectInstanceId\":\"%33[a-z0-9_]\","
    "\"quarantineIdentityDigest\":%95[^,],\"receiptDigest\":%95[^,],"
    "\"schema\":\"writcraft.snapshot-delete-transaction/v1\","
    "\"snapshotId\":\"%128[A-Za-z0-9_-]\","
    "\"snapshotManifestDigest\":\"%71[a-z0-9:]\","
    "\"sourceIdentityDigest\":\"%71[a-z0-9:]\",\"state\":\"%15[A-Z]\","
    "\"transactionId\":\"%128[A-Za-z0-9_-]\",\"updatedAt\":\"%96[0-9TZ:+.-]\"}\n%n",
    parsed.created_at,
    error,
    &parsed.owner_generation,
    parsed.project_instance_id,
    quarantine,
    receipt,
    parsed.snapshot_id,
    parsed.snapshot_manifest_digest,
    parsed.source_identity_digest,
    parsed.state,
    parsed.transaction_id,
    parsed.updated_at,
    &consumed
  );
  if (matched != 12 || consumed <= 0 || bytes[consumed] != '\0' ||
      !project_instance_id(parsed.project_instance_id) || !valid_opaque(parsed.snapshot_id) ||
      !valid_opaque(parsed.transaction_id) || !valid_digest(parsed.snapshot_manifest_digest) ||
      !valid_digest(parsed.source_identity_digest) || !safe_timestamp(parsed.created_at) ||
      !safe_timestamp(parsed.updated_at) || parsed.owner_generation > MAX_SAFE_INTEGER) return false;
  bool state_valid = strcmp(parsed.state, "PREPARING") == 0 ||
    strcmp(parsed.state, "UNCOMMITTED") == 0 || strcmp(parsed.state, "UNKNOWN") == 0 ||
    strcmp(parsed.state, "COMMITTED") == 0;
  if (!state_valid) return false;
  if (strcmp(quarantine, "null") != 0) {
    size_t length = strlen(quarantine);
    if (length != 73U || quarantine[0] != '"' || quarantine[72] != '"') return false;
    quarantine[72] = '\0';
    if (!valid_digest(quarantine + 1U)) return false;
    memcpy(parsed.quarantine_identity_digest, quarantine + 1U, 72U);
  }
  if (strcmp(receipt, "null") != 0) {
    size_t length = strlen(receipt);
    if (length != 73U || receipt[0] != '"' || receipt[72] != '"') return false;
    receipt[72] = '\0';
    if (!valid_digest(receipt + 1U)) return false;
    memcpy(parsed.receipt_digest, receipt + 1U, 72U);
  }
  if (strcmp(error, "null") != 0) {
    size_t length = strlen(error);
    if (length < 3U || length > 66U || error[0] != '"' || error[length - 1U] != '"') return false;
    error[length - 1U] = '\0';
    for (const char *cursor = error + 1U; *cursor != '\0'; cursor += 1U) {
      if (!(isupper((unsigned char)*cursor) || isdigit((unsigned char)*cursor) ||
            *cursor == '_')) return false;
    }
    memcpy(parsed.last_error_code, error + 1U, length - 1U);
  }
  bool nullability = strcmp(parsed.state, "PREPARING") == 0
    ? parsed.quarantine_identity_digest[0] == '\0' && parsed.receipt_digest[0] == '\0' &&
      parsed.last_error_code[0] == '\0'
    : strcmp(parsed.state, "COMMITTED") == 0
      ? parsed.quarantine_identity_digest[0] != '\0' && parsed.receipt_digest[0] != '\0' &&
        parsed.last_error_code[0] == '\0'
      : parsed.receipt_digest[0] == '\0' && parsed.last_error_code[0] != '\0';
  char canonical[4096];
  if (!nullability || !make_delete_transaction_json(&parsed, canonical, sizeof(canonical)) ||
      strcmp(canonical, bytes) != 0) return false;
  *out = parsed;
  return true;
}

static bool make_delete_recovery_json(
  const DeleteRecoveryRecord *record,
  char *out,
  size_t capacity,
  char digest_out[DIGEST_TEXT_BYTES + 1U]
) {
  char deleted[96];
  int deleted_length = record->expected_deleted_identity_digest[0] == '\0'
    ? snprintf(deleted, sizeof(deleted), "null")
    : snprintf(deleted, sizeof(deleted), "\"%s\"", record->expected_deleted_identity_digest);
  if (deleted_length <= 0 || (size_t)deleted_length >= sizeof(deleted)) return false;
  char without_digest[2048];
  int plain_length = snprintf(
    without_digest,
    sizeof(without_digest),
    "{\"expectedDeletedIdentityDigest\":%s,\"expectedManifestDigest\":\"%s\""
    ",\"schema\":\"writcraft.snapshot-delete-recovery/v1\",\"snapshotId\":\"%s\""
    ",\"state\":\"%s\",\"transactionId\":\"%s\",\"updatedAt\":\"%s\"}",
    deleted,
    record->expected_manifest_digest,
    record->snapshot_id,
    record->state,
    record->transaction_id,
    record->updated_at
  );
  if (plain_length <= 0 || (size_t)plain_length >= sizeof(without_digest) ||
      !digest_domain("writcraft.snapshot-delete-recovery/v1", without_digest, digest_out)) return false;
  int length = snprintf(
    out,
    capacity,
    "{\"expectedDeletedIdentityDigest\":%s,\"expectedManifestDigest\":\"%s\""
    ",\"markerDigest\":\"%s\",\"schema\":\"writcraft.snapshot-delete-recovery/v1\""
    ",\"snapshotId\":\"%s\",\"state\":\"%s\",\"transactionId\":\"%s\""
    ",\"updatedAt\":\"%s\"}\n",
    deleted,
    record->expected_manifest_digest,
    digest_out,
    record->snapshot_id,
    record->state,
    record->transaction_id,
    record->updated_at
  );
  return length > 0 && (size_t)length < capacity && (size_t)length <= MAX_RECORD_BYTES;
}

static bool parse_delete_recovery_json(const char *bytes, DeleteRecoveryRecord *out) {
  DeleteRecoveryRecord parsed;
  memset(&parsed, 0, sizeof(parsed));
  char deleted[96];
  int consumed = 0;
  int matched = sscanf(
    bytes,
    "{\"expectedDeletedIdentityDigest\":%95[^,],\"expectedManifestDigest\":\"%71[a-z0-9:]\""
    ",\"markerDigest\":\"%71[a-z0-9:]\","
    "\"schema\":\"writcraft.snapshot-delete-recovery/v1\","
    "\"snapshotId\":\"%128[A-Za-z0-9_-]\",\"state\":\"%15[A-Z]\","
    "\"transactionId\":\"%128[A-Za-z0-9_-]\",\"updatedAt\":\"%96[0-9TZ:+.-]\"}\n%n",
    deleted,
    parsed.expected_manifest_digest,
    parsed.marker_digest,
    parsed.snapshot_id,
    parsed.state,
    parsed.transaction_id,
    parsed.updated_at,
    &consumed
  );
  if (matched != 7 || consumed <= 0 || bytes[consumed] != '\0' ||
      !valid_digest(parsed.expected_manifest_digest) || !valid_digest(parsed.marker_digest) ||
      !valid_opaque(parsed.snapshot_id) || !valid_opaque(parsed.transaction_id) ||
      !safe_timestamp(parsed.updated_at) ||
      !(strcmp(parsed.state, "PREPARING") == 0 || strcmp(parsed.state, "UNCOMMITTED") == 0 ||
        strcmp(parsed.state, "UNKNOWN") == 0 || strcmp(parsed.state, "COMMITTED") == 0)) return false;
  if (strcmp(deleted, "null") != 0) {
    size_t length = strlen(deleted);
    if (length != 73U || deleted[0] != '"' || deleted[72] != '"') return false;
    deleted[72] = '\0';
    if (!valid_digest(deleted + 1U)) return false;
    memcpy(parsed.expected_deleted_identity_digest, deleted + 1U, 72U);
  }
  if (strcmp(parsed.state, "COMMITTED") == 0 &&
      parsed.expected_deleted_identity_digest[0] == '\0') return false;
  if (strcmp(parsed.state, "PREPARING") == 0 &&
      parsed.expected_deleted_identity_digest[0] != '\0') return false;
  char canonical[4096];
  char marker[DIGEST_TEXT_BYTES + 1U];
  if (!make_delete_recovery_json(&parsed, canonical, sizeof(canonical), marker) ||
      strcmp(marker, parsed.marker_digest) != 0 || strcmp(canonical, bytes) != 0) return false;
  *out = parsed;
  return true;
}

static bool make_delete_receipt_json(
  const DeleteReceiptRecord *record,
  char *out,
  size_t capacity,
  char digest_out[DIGEST_TEXT_BYTES + 1U]
) {
  char without_digest[2048];
  int plain_length = snprintf(
    without_digest,
    sizeof(without_digest),
    "{\"committedAt\":\"%s\",\"deletedIdentityDigest\":\"%s\""
    ",\"directoryFsyncComplete\":true,\"schema\":\"writcraft.snapshot-delete-receipt/v1\""
    ",\"snapshotId\":\"%s\",\"snapshotManifestDigest\":\"%s\""
    ",\"transactionId\":\"%s\"}",
    record->committed_at,
    record->deleted_identity_digest,
    record->snapshot_id,
    record->snapshot_manifest_digest,
    record->transaction_id
  );
  if (plain_length <= 0 || (size_t)plain_length >= sizeof(without_digest) ||
      !digest_domain("writcraft.snapshot-delete-receipt/v1", without_digest, digest_out)) return false;
  int length = snprintf(
    out,
    capacity,
    "{\"committedAt\":\"%s\",\"deletedIdentityDigest\":\"%s\""
    ",\"directoryFsyncComplete\":true,\"receiptDigest\":\"%s\""
    ",\"schema\":\"writcraft.snapshot-delete-receipt/v1\",\"snapshotId\":\"%s\""
    ",\"snapshotManifestDigest\":\"%s\",\"transactionId\":\"%s\"}\n",
    record->committed_at,
    record->deleted_identity_digest,
    digest_out,
    record->snapshot_id,
    record->snapshot_manifest_digest,
    record->transaction_id
  );
  return length > 0 && (size_t)length < capacity && (size_t)length <= MAX_RECORD_BYTES;
}

static bool parse_delete_receipt_json(const char *bytes, DeleteReceiptRecord *out) {
  DeleteReceiptRecord parsed;
  memset(&parsed, 0, sizeof(parsed));
  int consumed = 0;
  int matched = sscanf(
    bytes,
    "{\"committedAt\":\"%96[0-9TZ:+.-]\",\"deletedIdentityDigest\":\"%71[a-z0-9:]\""
    ",\"directoryFsyncComplete\":true,\"receiptDigest\":\"%71[a-z0-9:]\""
    ",\"schema\":\"writcraft.snapshot-delete-receipt/v1\","
    "\"snapshotId\":\"%128[A-Za-z0-9_-]\","
    "\"snapshotManifestDigest\":\"%71[a-z0-9:]\","
    "\"transactionId\":\"%128[A-Za-z0-9_-]\"}\n%n",
    parsed.committed_at,
    parsed.deleted_identity_digest,
    parsed.receipt_digest,
    parsed.snapshot_id,
    parsed.snapshot_manifest_digest,
    parsed.transaction_id,
    &consumed
  );
  if (matched != 6 || consumed <= 0 || bytes[consumed] != '\0' ||
      !safe_timestamp(parsed.committed_at) || !valid_digest(parsed.deleted_identity_digest) ||
      !valid_digest(parsed.receipt_digest) || !valid_opaque(parsed.snapshot_id) ||
      !valid_digest(parsed.snapshot_manifest_digest) || !valid_opaque(parsed.transaction_id)) return false;
  char canonical[4096];
  char receipt[DIGEST_TEXT_BYTES + 1U];
  if (!make_delete_receipt_json(&parsed, canonical, sizeof(canonical), receipt) ||
      strcmp(receipt, parsed.receipt_digest) != 0 || strcmp(canonical, bytes) != 0) return false;
  *out = parsed;
  return true;
}

static bool compute_quarantine_identity_digest(
  const StorageBinding *storage,
  const char *transaction_id,
  const char *quarantine_name,
  const Identity *identity,
  const BundleInfo *bundle,
  char out[DIGEST_TEXT_BYTES + 1U]
) {
  char basename_digest[DIGEST_TEXT_BYTES + 1U];
  char payload_digest[DIGEST_TEXT_BYTES + 1U];
  sha256_prefixed(
    (const unsigned char *)quarantine_name, strlen(quarantine_name), basename_digest
  );
  memcpy(payload_digest, "sha256:", 7U);
  digest_hex(bundle->payload_sha256, payload_digest + 7U);
  char canonical[2048];
  int length = snprintf(
    canonical,
    sizeof(canonical),
    "{\"bundlePayloadSha256\":\"%s\",\"dev\":\"%" PRIuMAX
    "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX
    ",\"nlink\":%" PRIuMAX ",\"parentIdentityDigest\":\"%s\""
    ",\"quarantineBasenameSha256\":\"%s\""
    ",\"schema\":\"writcraft.snapshot-quarantine-identity/v1\",\"size\":\"%" PRIuMAX
    "\",\"snapshotId\":\"%s\",\"snapshotManifestDigest\":\"%s\""
    ",\"transactionId\":\"%s\",\"uid\":%" PRIuMAX "}",
    payload_digest,
    identity->dev,
    identity->ino,
    permission_mode(identity->mode),
    identity->nlink,
    storage->quarantine_identity_digest,
    basename_digest,
    identity->size,
    bundle->snapshot_id,
    bundle->snapshot_manifest_digest,
    transaction_id,
    identity->uid
  );
  return length > 0 && (size_t)length < sizeof(canonical) &&
    digest_domain("writcraft.snapshot-quarantine-identity/v1", canonical, out);
}

static bool same_delete_receipt(
  const DeleteReceiptRecord *left,
  const DeleteReceiptRecord *right
) {
  return strcmp(left->transaction_id, right->transaction_id) == 0 &&
    strcmp(left->snapshot_id, right->snapshot_id) == 0 &&
    strcmp(left->deleted_identity_digest, right->deleted_identity_digest) == 0 &&
    strcmp(left->snapshot_manifest_digest, right->snapshot_manifest_digest) == 0 &&
    strcmp(left->committed_at, right->committed_at) == 0 &&
    strcmp(left->receipt_digest, right->receipt_digest) == 0;
}

static bool open_delete_receipt_candidate(
  const StorageBinding *storage,
  const char *name,
  int *fd_out,
  Identity *identity_out,
  DeleteReceiptRecord *receipt_out
) {
  int fd = openat(storage->control_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return false;
  char bytes[4096];
  struct stat value;
  Identity identity;
  DeleteReceiptRecord receipt;
  memset(&receipt, 0, sizeof(receipt));
  bool valid = read_owned_control_text(storage, name, fd, bytes, sizeof(bytes)) &&
    parse_delete_receipt_json(bytes, &receipt) && fstat(fd, &value) == 0 &&
    identity_from_stat(&value, &identity) && S_ISREG(value.st_mode) &&
    value.st_uid == geteuid() && (value.st_mode & 0777) == 0600 && value.st_nlink == 1;
  if (!valid) {
    (void)close(fd);
    return false;
  }
  *fd_out = fd;
  *identity_out = identity;
  *receipt_out = receipt;
  return true;
}

static bool validate_delete_receipt_uniqueness(
  const StorageBinding *storage,
  const char *expected_name,
  const Identity *expected_identity,
  const DeleteReceiptRecord *expected_receipt
) {
  int duplicate = fcntl(storage->control_fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return false;
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    (void)close(duplicate);
    return false;
  }
  rewinddir(directory);
  size_t matches = 0U;
  bool exact = true;
  struct dirent *entry = NULL;
  while ((entry = readdir(directory)) != NULL) {
    if (strncmp(entry->d_name, "delete-receipt-", 15U) != 0) continue;
    if (strlen(entry->d_name) != 84U || strcmp(entry->d_name + 79U, ".json") != 0) continue;
    int fd = -1;
    Identity identity;
    DeleteReceiptRecord receipt;
    memset(&receipt, 0, sizeof(receipt));
    if (!open_delete_receipt_candidate(storage, entry->d_name, &fd, &identity, &receipt)) {
      continue;
    }
    if (strcmp(receipt.transaction_id, expected_receipt->transaction_id) == 0 &&
        strcmp(receipt.snapshot_id, expected_receipt->snapshot_id) == 0 &&
        strcmp(receipt.deleted_identity_digest, expected_receipt->deleted_identity_digest) == 0 &&
        strcmp(receipt.snapshot_manifest_digest, expected_receipt->snapshot_manifest_digest) == 0) {
      matches += 1U;
      if (strcmp(entry->d_name, expected_name) != 0 ||
          !same_regular_identity(&identity, expected_identity) ||
          !same_delete_receipt(&receipt, expected_receipt)) exact = false;
    }
    (void)close(fd);
  }
  (void)closedir(directory);
  return exact && matches == 1U;
}

static bool open_exact_delete_receipt(
  const StorageBinding *storage,
  const char *name,
  const DeleteReceiptRecord *expected,
  int *fd_out,
  Identity *identity_out
) {
  DeleteReceiptRecord receipt;
  memset(&receipt, 0, sizeof(receipt));
  int fd = -1;
  Identity identity;
  bool valid = open_delete_receipt_candidate(storage, name, &fd, &identity, &receipt) &&
    same_delete_receipt(&receipt, expected) &&
    validate_delete_receipt_uniqueness(storage, name, &identity, &receipt);
  if (!valid) {
    if (fd >= 0) (void)close(fd);
    return false;
  }
  *fd_out = fd;
  *identity_out = identity;
  return true;
}

static bool quarantine_path_matches(
  const StorageBinding *storage,
  const char *name,
  int held_fd,
  const Identity *expected_identity
) {
  struct stat held;
  struct stat at_path;
  Identity held_identity;
  Identity path_identity;
  return fstat(held_fd, &held) == 0 &&
    fstatat(storage->quarantine_fd, name, &at_path, AT_SYMLINK_NOFOLLOW) == 0 &&
    identity_from_stat(&held, &held_identity) && identity_from_stat(&at_path, &path_identity) &&
    same_regular_identity(expected_identity, &held_identity) &&
    same_regular_identity(expected_identity, &path_identity);
}

static bool open_valid_quarantine(
  const StorageBinding *storage,
  const char *transaction_id,
  const char *snapshot_id,
  const char *manifest_digest,
  const char *name,
  int *fd_out,
  Identity *identity_out,
  BundleInfo *bundle_out,
  unsigned char full_digest[CC_SHA256_DIGEST_LENGTH],
  char quarantine_digest[DIGEST_TEXT_BYTES + 1U]
) {
  int fd = openat(
    storage->quarantine_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC
  );
  if (fd < 0) return false;
  struct stat held;
  struct stat at_path;
  Identity identity;
  Identity path_identity;
  bool valid = fstat(fd, &held) == 0 && fstatat(
      storage->quarantine_fd, name, &at_path, AT_SYMLINK_NOFOLLOW
    ) == 0 && identity_from_stat(&held, &identity) && identity_from_stat(&at_path, &path_identity) &&
    same_regular_identity(&identity, &path_identity) && held.st_uid == geteuid() &&
    (held.st_mode & 0777) == 0600 && held.st_nlink == 1 &&
    validate_bundle_fd(fd, snapshot_id, manifest_digest, bundle_out) &&
    hash_fd_stable(fd, identity_out, full_digest) && same_regular_identity(&identity, identity_out) &&
    compute_quarantine_identity_digest(
      storage, transaction_id, name, identity_out, bundle_out, quarantine_digest
    );
  if (!valid) {
    (void)close(fd);
    return false;
  }
  *fd_out = fd;
  return true;
}

static bool find_transaction_quarantine(
  const StorageBinding *storage,
  const char *prefix,
  const char *transaction_id,
  const char *snapshot_id,
  const char *manifest_digest,
  char name_out[96],
  int *fd_out,
  Identity *identity_out,
  BundleInfo *bundle_out,
  unsigned char full_digest[CC_SHA256_DIGEST_LENGTH],
  char quarantine_digest[DIGEST_TEXT_BYTES + 1U]
) {
  int duplicate = fcntl(storage->quarantine_fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return false;
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    (void)close(duplicate);
    return false;
  }
  rewinddir(directory);
  size_t prefix_length = strlen(prefix);
  size_t candidates = 0U;
  bool valid = false;
  int found_fd = -1;
  Identity found_identity;
  BundleInfo found_bundle;
  unsigned char found_full_digest[CC_SHA256_DIGEST_LENGTH];
  char found_digest[DIGEST_TEXT_BYTES + 1U];
  char found_name[96];
  struct dirent *entry = NULL;
  while ((entry = readdir(directory)) != NULL) {
    if (strncmp(entry->d_name, prefix, prefix_length) != 0) continue;
    candidates += 1U;
    if (candidates > 1U || strlen(entry->d_name) >= sizeof(found_name)) continue;
    memset(&found_bundle, 0, sizeof(found_bundle));
    valid = open_valid_quarantine(
      storage,
      transaction_id,
      snapshot_id,
      manifest_digest,
      entry->d_name,
      &found_fd,
      &found_identity,
      &found_bundle,
      found_full_digest,
      found_digest
    );
    if (valid) memcpy(found_name, entry->d_name, strlen(entry->d_name) + 1U);
  }
  (void)closedir(directory);
  if (candidates != 1U || !valid) {
    if (found_fd >= 0) (void)close(found_fd);
    return false;
  }
  memcpy(name_out, found_name, strlen(found_name) + 1U);
  *fd_out = found_fd;
  *identity_out = found_identity;
  *bundle_out = found_bundle;
  memcpy(full_digest, found_full_digest, CC_SHA256_DIGEST_LENGTH);
  memcpy(quarantine_digest, found_digest, DIGEST_TEXT_BYTES + 1U);
  return true;
}

static bool quarantine_prefix_absent(const StorageBinding *storage, const char *prefix) {
  int duplicate = fcntl(storage->quarantine_fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return false;
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    (void)close(duplicate);
    return false;
  }
  rewinddir(directory);
  size_t prefix_length = strlen(prefix);
  bool absent = true;
  struct dirent *entry = NULL;
  while ((entry = readdir(directory)) != NULL) {
    if (strncmp(entry->d_name, prefix, prefix_length) == 0) {
      absent = false;
      break;
    }
  }
  (void)closedir(directory);
  return absent;
}

static bool rewrite_delete_records(
  const StorageBinding *storage,
  const char *transaction_name,
  int transaction_fd,
  DeleteTransactionRecord *transaction,
  const char *recovery_name,
  int recovery_fd,
  DeleteRecoveryRecord *recovery,
  const char *state,
  const char *quarantine_digest,
  const char *receipt_digest,
  const char *error_code,
  const char *updated_at
) {
  memcpy(transaction->state, state, strlen(state) + 1U);
  memcpy(recovery->state, state, strlen(state) + 1U);
  memcpy(transaction->updated_at, updated_at, strlen(updated_at) + 1U);
  memcpy(recovery->updated_at, updated_at, strlen(updated_at) + 1U);
  transaction->quarantine_identity_digest[0] = '\0';
  recovery->expected_deleted_identity_digest[0] = '\0';
  transaction->receipt_digest[0] = '\0';
  transaction->last_error_code[0] = '\0';
  if (quarantine_digest != NULL) {
    memcpy(
      transaction->quarantine_identity_digest,
      quarantine_digest,
      strlen(quarantine_digest) + 1U
    );
    memcpy(
      recovery->expected_deleted_identity_digest,
      quarantine_digest,
      strlen(quarantine_digest) + 1U
    );
  }
  if (receipt_digest != NULL) {
    memcpy(transaction->receipt_digest, receipt_digest, strlen(receipt_digest) + 1U);
  }
  if (error_code != NULL) {
    memcpy(transaction->last_error_code, error_code, strlen(error_code) + 1U);
  }
  char transaction_json[4096];
  char recovery_json[4096];
  char marker_digest[DIGEST_TEXT_BYTES + 1U];
  bool a = make_delete_transaction_json(
    transaction, transaction_json, sizeof(transaction_json)
  );
  bool b = a && make_delete_recovery_json(
    recovery, recovery_json, sizeof(recovery_json), marker_digest
  );
  bool c = b && rewrite_control_record(
    storage, recovery_name, recovery_fd, recovery_json
  );
  bool d = c && rewrite_control_record(
    storage, transaction_name, transaction_fd, transaction_json
  );
  bool e = d && fsync(storage->control_fd) == 0;
  return e;
}

static bool source_path_matches_held(
  const StorageBinding *storage,
  const char *final_name,
  int held_fd
) {
  struct stat held;
  struct stat at_path;
  return fstat(held_fd, &held) == 0 &&
    fstatat(storage->bundles_fd, final_name, &at_path, AT_SYMLINK_NOFOLLOW) == 0 &&
    held.st_dev == at_path.st_dev && held.st_ino == at_path.st_ino &&
    S_ISREG(held.st_mode) && S_ISREG(at_path.st_mode);
}

static bool validate_source_receipt(
  const StorageBinding *storage,
  const char *final_name,
  int source_fd,
  const Identity *source_identity,
  const BundleInfo *source_bundle,
  const char *source_digest,
  unsigned char full_digest[CC_SHA256_DIGEST_LENGTH]
) {
  Identity hashed_identity;
  char receipt_name[96];
  int receipt_fd = -1;
  Identity receipt_identity;
  ReceiptRecord receipt;
  memset(&receipt, 0, sizeof(receipt));
  bool valid = hash_fd_stable(source_fd, &hashed_identity, full_digest) &&
    same_regular_identity(source_identity, &hashed_identity) &&
    open_receipt_for_bundle(
      storage,
      source_bundle,
      source_digest,
      receipt_name,
      &receipt_fd,
      &receipt_identity,
      &receipt
    ) && validate_receipt_terminal(
      storage,
      receipt_name,
      receipt_fd,
      &receipt_identity,
      &receipt,
      source_bundle,
      source_digest
    ) && source_path_matches_held(storage, final_name, source_fd);
  if (receipt_fd >= 0) (void)close(receipt_fd);
  return valid;
}

static bool validate_create_receipt_without_source_path(
  const StorageBinding *storage,
  const BundleInfo *bundle,
  const char *published_digest
) {
  char receipt_name[96];
  int receipt_fd = -1;
  Identity receipt_identity;
  ReceiptRecord receipt;
  memset(&receipt, 0, sizeof(receipt));
  bool valid = open_receipt_for_bundle(
      storage,
      bundle,
      published_digest,
      receipt_name,
      &receipt_fd,
      &receipt_identity,
      &receipt
    ) && validate_receipt_terminal(
      storage,
      receipt_name,
      receipt_fd,
      &receipt_identity,
      &receipt,
      bundle,
      published_digest
    );
  if (receipt_fd >= 0) (void)close(receipt_fd);
  return valid;
}

static bool create_or_validate_delete_receipt(
  const StorageBinding *storage,
  const char *receipt_name,
  const DeleteTransactionRecord *transaction,
  const char *deleted_identity_digest,
  DeleteReceiptRecord *receipt_out
) {
  DeleteReceiptRecord expected;
  memset(&expected, 0, sizeof(expected));
  memcpy(expected.transaction_id, transaction->transaction_id, strlen(transaction->transaction_id) + 1U);
  memcpy(expected.snapshot_id, transaction->snapshot_id, strlen(transaction->snapshot_id) + 1U);
  memcpy(
    expected.deleted_identity_digest,
    deleted_identity_digest,
    strlen(deleted_identity_digest) + 1U
  );
  memcpy(
    expected.snapshot_manifest_digest,
    transaction->snapshot_manifest_digest,
    strlen(transaction->snapshot_manifest_digest) + 1U
  );
  memcpy(expected.committed_at, transaction->created_at, strlen(transaction->created_at) + 1U);
  char receipt_json[4096];
  char receipt_digest[DIGEST_TEXT_BYTES + 1U];
  if (!make_delete_receipt_json(
        &expected, receipt_json, sizeof(receipt_json), receipt_digest
      )) return false;
  memcpy(expected.receipt_digest, receipt_digest, strlen(receipt_digest) + 1U);
  int receipt_fd = -1;
  Identity receipt_identity;
  bool created = create_control_record(storage, receipt_name, receipt_json, &receipt_fd);
  if (created && fsync(storage->control_fd) != 0) {
    (void)close(receipt_fd);
    return false;
  }
  if (!created && !open_exact_delete_receipt(
        storage, receipt_name, &expected, &receipt_fd, &receipt_identity
      )) return false;
  if (created) {
    struct stat value;
    bool identity_valid = fstat(receipt_fd, &value) == 0 &&
      identity_from_stat(&value, &receipt_identity);
    bool unique = identity_valid && validate_delete_receipt_uniqueness(
      storage, receipt_name, &receipt_identity, &expected
    );
    if (!unique) {
      (void)close(receipt_fd);
      return false;
    }
  }
  (void)close(receipt_fd);
  *receipt_out = expected;
  return true;
}

static bool commit_deleted_truth(
  RootBinding *root,
  StorageBinding *storage,
  const char *transaction_name,
  int transaction_fd,
  DeleteTransactionRecord *transaction,
  const char *recovery_name,
  int recovery_fd,
  DeleteRecoveryRecord *recovery,
  const char *receipt_name,
  const char *deleted_identity_digest,
  const char *final_name,
  const char *quarantine_prefix,
  const char *updated_at
) {
  DeleteReceiptRecord receipt;
  memset(&receipt, 0, sizeof(receipt));
  return path_absent_at(storage->bundles_fd, final_name) &&
    quarantine_prefix_absent(storage, quarantine_prefix) &&
    fsync(storage->bundles_fd) == 0 && fsync(storage->quarantine_fd) == 0 &&
    create_or_validate_delete_receipt(
      storage, receipt_name, transaction, deleted_identity_digest, &receipt
    ) && rewrite_delete_records(
      storage,
      transaction_name,
      transaction_fd,
      transaction,
      recovery_name,
      recovery_fd,
      recovery,
      "COMMITTED",
      deleted_identity_digest,
      receipt.receipt_digest,
      NULL,
      updated_at
    ) && path_absent_at(storage->bundles_fd, final_name) &&
    quarantine_prefix_absent(storage, quarantine_prefix) &&
    revalidate_root(root) && revalidate_storage(root, storage);
}

static bool settle_delete_uncommitted(
  RootBinding *root,
  StorageBinding *storage,
  const char *transaction_name,
  int transaction_fd,
  DeleteTransactionRecord *transaction,
  const char *recovery_name,
  int recovery_fd,
  DeleteRecoveryRecord *recovery,
  const char *quarantine_prefix,
  const char *updated_at,
  const char *error_code
) {
  return quarantine_prefix_absent(storage, quarantine_prefix) &&
    fsync(storage->bundles_fd) == 0 && fsync(storage->quarantine_fd) == 0 &&
    rewrite_delete_records(
      storage,
      transaction_name,
      transaction_fd,
      transaction,
      recovery_name,
      recovery_fd,
      recovery,
      "UNCOMMITTED",
      NULL,
      NULL,
      error_code,
      updated_at
    ) && revalidate_root(root) && revalidate_storage(root, storage);
}

static bool write_delete_terminal(
  char command,
  const char *transaction_id,
  const char *state,
  const char *identity_digest,
  const char *receipt_digest,
  const char *reason
) {
  char response[768];
  int length = 0;
  if (strcmp(state, "COMMITTED") == 0) {
    length = snprintf(
      response,
      sizeof(response),
      "%c\tOK\t%s\tCOMMITTED\t%s\t%s\n",
      command,
      transaction_id,
      identity_digest,
      receipt_digest
    );
  } else {
    length = snprintf(
      response,
      sizeof(response),
      "%c\tOK\t%s\tUNCOMMITTED\t%s\n",
      command,
      transaction_id,
      reason
    );
  }
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static bool delete_request_fields(
  char *line,
  char expected_command,
  char **fields,
  uint64_t *owner_generation
) {
  size_t count = 0U;
  char command[2] = {expected_command, '\0'};
  return split_fields(line, fields, 8U, &count) && count == 8U &&
    strcmp(fields[0], command) == 0 && valid_opaque(fields[1]) &&
    project_instance_id(fields[2]) && valid_opaque(fields[3]) &&
    decimal_uint64(fields[4], owner_generation) && *owner_generation <= MAX_SAFE_INTEGER &&
    valid_digest(fields[5]) && valid_digest(fields[6]) && safe_timestamp(fields[7]);
}

static bool delete_record_matches_request(
  const DeleteTransactionRecord *transaction,
  char **fields,
  uint64_t owner_generation
) {
  return strcmp(transaction->transaction_id, fields[1]) == 0 &&
    strcmp(transaction->project_instance_id, fields[2]) == 0 &&
    strcmp(transaction->snapshot_id, fields[3]) == 0 &&
    transaction->owner_generation == owner_generation &&
    strcmp(transaction->snapshot_manifest_digest, fields[5]) == 0 &&
    strcmp(transaction->source_identity_digest, fields[6]) == 0;
}

static bool delete_recovery_matches_transaction(
  const DeleteRecoveryRecord *recovery,
  const DeleteTransactionRecord *transaction
) {
  return strcmp(recovery->transaction_id, transaction->transaction_id) == 0 &&
    strcmp(recovery->snapshot_id, transaction->snapshot_id) == 0 &&
    strcmp(recovery->expected_manifest_digest, transaction->snapshot_manifest_digest) == 0;
}

static bool open_delete_control_records(
  const StorageBinding *storage,
  const char *transaction_name,
  int *transaction_fd_out,
  DeleteTransactionRecord *transaction_out,
  const char *recovery_name,
  int *recovery_fd_out,
  DeleteRecoveryRecord *recovery_out
) {
  int transaction_fd = -1;
  int recovery_fd = -1;
  char transaction_bytes[4096];
  char recovery_bytes[4096];
  bool valid = open_control_rw(storage, transaction_name, &transaction_fd) &&
    read_owned_control_text(
      storage, transaction_name, transaction_fd, transaction_bytes, sizeof(transaction_bytes)
    ) && parse_delete_transaction_json(transaction_bytes, transaction_out) &&
    open_control_rw(storage, recovery_name, &recovery_fd) &&
    read_owned_control_text(
      storage, recovery_name, recovery_fd, recovery_bytes, sizeof(recovery_bytes)
    ) && parse_delete_recovery_json(recovery_bytes, recovery_out) &&
    delete_recovery_matches_transaction(recovery_out, transaction_out);
  if (!valid) {
    if (transaction_fd >= 0) (void)close(transaction_fd);
    if (recovery_fd >= 0) (void)close(recovery_fd);
    return false;
  }
  *transaction_fd_out = transaction_fd;
  *recovery_fd_out = recovery_fd;
  return true;
}

static bool prove_exact_source(
  StorageBinding *storage,
  const char *final_name,
  const char *snapshot_id,
  const char *manifest_digest,
  const char *published_digest,
  int *source_fd_out,
  Identity *source_identity_out,
  BundleInfo *source_bundle_out,
  unsigned char full_digest[CC_SHA256_DIGEST_LENGTH]
) {
  char computed_digest[DIGEST_TEXT_BYTES + 1U];
  int source_fd = -1;
  Identity identity;
  BundleInfo bundle;
  memset(&bundle, 0, sizeof(bundle));
  bool valid = open_valid_published(
      storage,
      final_name,
      snapshot_id,
      manifest_digest,
      &source_fd,
      &identity,
      &bundle,
      computed_digest
    ) && strcmp(computed_digest, published_digest) == 0 &&
    validate_source_receipt(
      storage,
      final_name,
      source_fd,
      &identity,
      &bundle,
      computed_digest,
      full_digest
    );
  if (!valid) {
    if (source_fd >= 0) (void)close(source_fd);
    return false;
  }
  *source_fd_out = source_fd;
  *source_identity_out = identity;
  *source_bundle_out = bundle;
  return true;
}

static bool delete_committed_snapshot(
  char *line,
  RootBinding *root,
  StorageBinding *storage
) {
  char *fields[8];
  uint64_t owner_generation = 0U;
  if (!delete_request_fields(line, 'Y', fields, &owner_generation)) {
    return write_error('Y', "PROTOCOL") && false;
  }
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    return write_error('Y', "ROOT") && false;
  }
  char transaction_name[96];
  char recovery_name[96];
  char receipt_name[96];
  char quarantine_prefix[64];
  char final_name[96];
  if (!delete_record_names(
        fields[1], transaction_name, recovery_name, receipt_name, quarantine_prefix
      ) || !final_name_for_snapshot(fields[3], final_name)) {
    return write_error('Y', "PROTOCOL") && false;
  }
  if (!path_absent_at(storage->control_fd, transaction_name) ||
      !path_absent_at(storage->control_fd, recovery_name) ||
      !path_absent_at(storage->control_fd, receipt_name) ||
      !quarantine_prefix_absent(storage, quarantine_prefix)) {
    return write_error('Y', "UNKNOWN") && false;
  }

  int source_fd = -1;
  Identity source_identity;
  BundleInfo source_bundle;
  unsigned char source_full_digest[CC_SHA256_DIGEST_LENGTH];
  memset(&source_bundle, 0, sizeof(source_bundle));
  if (!prove_exact_source(
        storage,
        final_name,
        fields[3],
        fields[5],
        fields[6],
        &source_fd,
        &source_identity,
        &source_bundle,
        source_full_digest
      )) {
    return write_delete_terminal(
      'Y', fields[1], "UNCOMMITTED", NULL, NULL, "SOURCE_NOT_EXACT"
    );
  }

  DeleteTransactionRecord transaction;
  DeleteRecoveryRecord recovery;
  memset(&transaction, 0, sizeof(transaction));
  memset(&recovery, 0, sizeof(recovery));
  memcpy(transaction.transaction_id, fields[1], strlen(fields[1]) + 1U);
  memcpy(transaction.project_instance_id, fields[2], strlen(fields[2]) + 1U);
  memcpy(transaction.snapshot_id, fields[3], strlen(fields[3]) + 1U);
  transaction.owner_generation = owner_generation;
  memcpy(transaction.state, "PREPARING", sizeof("PREPARING"));
  memcpy(transaction.source_identity_digest, fields[6], strlen(fields[6]) + 1U);
  memcpy(transaction.snapshot_manifest_digest, fields[5], strlen(fields[5]) + 1U);
  memcpy(transaction.created_at, fields[7], strlen(fields[7]) + 1U);
  memcpy(transaction.updated_at, fields[7], strlen(fields[7]) + 1U);
  memcpy(recovery.transaction_id, fields[1], strlen(fields[1]) + 1U);
  memcpy(recovery.snapshot_id, fields[3], strlen(fields[3]) + 1U);
  memcpy(recovery.expected_manifest_digest, fields[5], strlen(fields[5]) + 1U);
  memcpy(recovery.state, "PREPARING", sizeof("PREPARING"));
  memcpy(recovery.updated_at, fields[7], strlen(fields[7]) + 1U);
  char transaction_json[4096];
  char recovery_json[4096];
  char marker_digest[DIGEST_TEXT_BYTES + 1U];
  int transaction_fd = -1;
  int recovery_fd = -1;
  bool records_ready = make_delete_transaction_json(
      &transaction, transaction_json, sizeof(transaction_json)
    ) && make_delete_recovery_json(
      &recovery, recovery_json, sizeof(recovery_json), marker_digest
    ) && create_control_record(
      storage, transaction_name, transaction_json, &transaction_fd
    ) && create_control_record(
      storage, recovery_name, recovery_json, &recovery_fd
    ) && fsync(storage->control_fd) == 0;
  if (!records_ready) goto unknown;

#ifdef WRITCRAFT_TEST_PAUSE_DELETE_BEFORE_RENAME
  if (!test_sync_point("delete-before-rename")) goto unknown;
#endif
  unsigned char rechecked_full_digest[CC_SHA256_DIGEST_LENGTH];
  Identity rechecked_identity;
  if (!revalidate_root(root) || !revalidate_storage(root, storage) ||
      !hash_fd_stable(source_fd, &rechecked_identity, rechecked_full_digest) ||
      !same_regular_identity(&source_identity, &rechecked_identity) ||
      memcmp(source_full_digest, rechecked_full_digest, sizeof(source_full_digest)) != 0 ||
      !validate_bundle_fd(source_fd, fields[3], fields[5], &source_bundle) ||
      !validate_create_receipt_without_source_path(storage, &source_bundle, fields[6]) ||
      !source_path_matches_held(storage, final_name, source_fd)) {
    if (revalidate_root(root) && revalidate_storage(root, storage) &&
        source_path_matches_held(storage, final_name, source_fd) &&
        settle_delete_uncommitted(
          root,
          storage,
          transaction_name,
          transaction_fd,
          &transaction,
          recovery_name,
          recovery_fd,
          &recovery,
          quarantine_prefix,
          fields[7],
          "SOURCE_DRIFT"
        )) {
      (void)close(source_fd);
      (void)close(transaction_fd);
      (void)close(recovery_fd);
      return write_delete_terminal(
        'Y', fields[1], "UNCOMMITTED", NULL, NULL, "SOURCE_DRIFT"
      );
    }
    goto unknown;
  }

  char quarantine_name[96];
  if (!random_quarantine_name(quarantine_prefix, quarantine_name)) goto unknown;
  if (renameatx_np(
        storage->bundles_fd,
        final_name,
        storage->quarantine_fd,
        quarantine_name,
        RENAME_EXCL
      ) != 0) {
    if (source_path_matches_held(storage, final_name, source_fd) &&
        settle_delete_uncommitted(
          root,
          storage,
          transaction_name,
          transaction_fd,
          &transaction,
          recovery_name,
          recovery_fd,
          &recovery,
          quarantine_prefix,
          fields[7],
          "RENAME_REJECTED"
        )) {
      (void)close(source_fd);
      (void)close(transaction_fd);
      (void)close(recovery_fd);
      return write_delete_terminal(
        'Y', fields[1], "UNCOMMITTED", NULL, NULL, "RENAME_REJECTED"
      );
    }
    goto unknown;
  }

#ifdef WRITCRAFT_TEST_PAUSE_DELETE_AFTER_RENAME
  if (!test_sync_point("delete-after-rename")) goto unknown;
#endif
  int quarantine_fd = -1;
  Identity quarantine_identity;
  BundleInfo quarantine_bundle;
  unsigned char quarantine_full_digest[CC_SHA256_DIGEST_LENGTH];
  char quarantine_digest[DIGEST_TEXT_BYTES + 1U];
  memset(&quarantine_bundle, 0, sizeof(quarantine_bundle));
  char recomputed_source_digest[DIGEST_TEXT_BYTES + 1U];
  bool reopened = path_absent_at(storage->bundles_fd, final_name) &&
    open_valid_quarantine(
      storage,
      fields[1],
      fields[3],
      fields[5],
      quarantine_name,
      &quarantine_fd,
      &quarantine_identity,
      &quarantine_bundle,
      quarantine_full_digest,
      quarantine_digest
    ) && same_file_object(&source_identity, &quarantine_identity) &&
    memcmp(source_full_digest, quarantine_full_digest, sizeof(source_full_digest)) == 0 &&
    compute_published_identity_digest(
      storage, final_name, &quarantine_identity, &quarantine_bundle, recomputed_source_digest
    ) && strcmp(recomputed_source_digest, fields[6]) == 0 &&
    validate_create_receipt_without_source_path(storage, &quarantine_bundle, fields[6]) &&
    rewrite_delete_records(
      storage,
      transaction_name,
      transaction_fd,
      &transaction,
      recovery_name,
      recovery_fd,
      &recovery,
      "UNKNOWN",
      quarantine_digest,
      NULL,
      "DELETE_IN_PROGRESS",
      fields[7]
    );
  if (!reopened) {
    if (quarantine_fd >= 0) (void)close(quarantine_fd);
    goto unknown;
  }

#ifdef WRITCRAFT_TEST_PAUSE_DELETE_BEFORE_UNLINK
  if (!test_sync_point("delete-before-unlink")) {
    (void)close(quarantine_fd);
    goto unknown;
  }
#endif
  Identity terminal_identity;
  BundleInfo terminal_bundle;
  unsigned char terminal_full_digest[CC_SHA256_DIGEST_LENGTH];
  char terminal_quarantine_digest[DIGEST_TEXT_BYTES + 1U];
  int terminal_fd = -1;
  memset(&terminal_bundle, 0, sizeof(terminal_bundle));
  bool terminal_exact = revalidate_root(root) && revalidate_storage(root, storage) &&
    path_absent_at(storage->bundles_fd, final_name) &&
    open_valid_quarantine(
      storage,
      fields[1],
      fields[3],
      fields[5],
      quarantine_name,
      &terminal_fd,
      &terminal_identity,
      &terminal_bundle,
      terminal_full_digest,
      terminal_quarantine_digest
    ) && same_regular_identity(&quarantine_identity, &terminal_identity) &&
    memcmp(quarantine_full_digest, terminal_full_digest, sizeof(terminal_full_digest)) == 0 &&
    strcmp(quarantine_digest, terminal_quarantine_digest) == 0 &&
    quarantine_path_matches(
      storage, quarantine_name, terminal_fd, &terminal_identity
    );
  if (!terminal_exact) {
    if (terminal_fd >= 0) (void)close(terminal_fd);
    (void)close(quarantine_fd);
    goto unknown;
  }
  bool unlinked = unlinkat(storage->quarantine_fd, quarantine_name, 0) == 0;
  (void)close(terminal_fd);
  (void)close(quarantine_fd);
  if (!unlinked) goto unknown;

#ifdef WRITCRAFT_TEST_PAUSE_DELETE_AFTER_UNLINK
  if (!test_sync_point("delete-after-unlink")) goto unknown;
#endif
  if (!commit_deleted_truth(
        root,
        storage,
        transaction_name,
        transaction_fd,
        &transaction,
        recovery_name,
        recovery_fd,
        &recovery,
        receipt_name,
        quarantine_digest,
        final_name,
        quarantine_prefix,
        fields[7]
      )) goto unknown;
  (void)close(source_fd);
  (void)close(transaction_fd);
  (void)close(recovery_fd);
#ifdef WRITCRAFT_TEST_DROP_DELETE_COMMITTED_RESPONSE
  _exit(89);
#endif
  return write_delete_terminal(
    'Y', fields[1], "COMMITTED", quarantine_digest, transaction.receipt_digest, NULL
  );

unknown:
  if (source_fd >= 0) (void)close(source_fd);
  if (transaction_fd >= 0) (void)close(transaction_fd);
  if (recovery_fd >= 0) (void)close(recovery_fd);
  return write_error('Y', "UNKNOWN") && false;
}

static bool reconcile_delete(
  char *line,
  RootBinding *root,
  StorageBinding *storage
) {
  char *fields[8];
  uint64_t owner_generation = 0U;
  if (!delete_request_fields(line, 'Z', fields, &owner_generation)) {
    return write_error('Z', "PROTOCOL") && false;
  }
  if (!revalidate_root(root) || !revalidate_storage(root, storage)) {
    return write_error('Z', "ROOT") && false;
  }
  char transaction_name[96];
  char recovery_name[96];
  char receipt_name[96];
  char quarantine_prefix[64];
  char final_name[96];
  if (!delete_record_names(
        fields[1], transaction_name, recovery_name, receipt_name, quarantine_prefix
      ) || !final_name_for_snapshot(fields[3], final_name)) {
    return write_error('Z', "PROTOCOL") && false;
  }
  int transaction_fd = -1;
  int recovery_fd = -1;
  DeleteTransactionRecord transaction;
  DeleteRecoveryRecord recovery;
  memset(&transaction, 0, sizeof(transaction));
  memset(&recovery, 0, sizeof(recovery));
  if (!open_delete_control_records(
        storage,
        transaction_name,
        &transaction_fd,
        &transaction,
        recovery_name,
        &recovery_fd,
        &recovery
      ) || !delete_record_matches_request(&transaction, fields, owner_generation)) goto unknown;

  if (strcmp(transaction.state, "COMMITTED") == 0) {
    DeleteReceiptRecord expected;
    memset(&expected, 0, sizeof(expected));
    memcpy(expected.transaction_id, transaction.transaction_id, strlen(transaction.transaction_id) + 1U);
    memcpy(expected.snapshot_id, transaction.snapshot_id, strlen(transaction.snapshot_id) + 1U);
    memcpy(
      expected.deleted_identity_digest,
      transaction.quarantine_identity_digest,
      strlen(transaction.quarantine_identity_digest) + 1U
    );
    memcpy(
      expected.snapshot_manifest_digest,
      transaction.snapshot_manifest_digest,
      strlen(transaction.snapshot_manifest_digest) + 1U
    );
    memcpy(expected.committed_at, transaction.created_at, strlen(transaction.created_at) + 1U);
    char receipt_json[4096];
    char receipt_digest[DIGEST_TEXT_BYTES + 1U];
    int receipt_fd = -1;
    Identity receipt_identity;
    bool receipt_built = make_delete_receipt_json(
      &expected, receipt_json, sizeof(receipt_json), receipt_digest
    );
    if (receipt_built) {
      memcpy(expected.receipt_digest, receipt_digest, strlen(receipt_digest) + 1U);
    }
    bool committed = receipt_built && strcmp(recovery.state, "COMMITTED") == 0 &&
      strcmp(
        recovery.expected_deleted_identity_digest,
        transaction.quarantine_identity_digest
      ) == 0 && strcmp(receipt_digest, transaction.receipt_digest) == 0;
    committed = committed && open_exact_delete_receipt(
      storage, receipt_name, &expected, &receipt_fd, &receipt_identity
    ) && path_absent_at(storage->bundles_fd, final_name) &&
      quarantine_prefix_absent(storage, quarantine_prefix) &&
      fsync(storage->bundles_fd) == 0 && fsync(storage->quarantine_fd) == 0 &&
      fsync(storage->control_fd) == 0 && revalidate_root(root) &&
      revalidate_storage(root, storage);
    if (receipt_fd >= 0) (void)close(receipt_fd);
    if (!committed) goto unknown;
    (void)close(transaction_fd);
    (void)close(recovery_fd);
    return write_delete_terminal(
      'Z', fields[1], "COMMITTED", transaction.quarantine_identity_digest,
      transaction.receipt_digest, NULL
    );
  }

  if (strcmp(transaction.state, "UNCOMMITTED") == 0) {
    int source_fd = -1;
    Identity source_identity;
    BundleInfo source_bundle;
    unsigned char source_digest[CC_SHA256_DIGEST_LENGTH];
    memset(&source_bundle, 0, sizeof(source_bundle));
    bool uncommitted = strcmp(recovery.state, "UNCOMMITTED") == 0 &&
      recovery.expected_deleted_identity_digest[0] == '\0' &&
      quarantine_prefix_absent(storage, quarantine_prefix) && prove_exact_source(
        storage,
        final_name,
        fields[3],
        fields[5],
        fields[6],
        &source_fd,
        &source_identity,
        &source_bundle,
        source_digest
      ) && fsync(storage->bundles_fd) == 0 && fsync(storage->quarantine_fd) == 0 &&
      fsync(storage->control_fd) == 0 && revalidate_root(root) &&
      revalidate_storage(root, storage);
    if (source_fd >= 0) (void)close(source_fd);
    if (!uncommitted) goto unknown;
    (void)close(transaction_fd);
    (void)close(recovery_fd);
    return write_delete_terminal(
      'Z', fields[1], "UNCOMMITTED", NULL, NULL, transaction.last_error_code
    );
  }

  char quarantine_name[96];
  int quarantine_fd = -1;
  Identity quarantine_identity;
  BundleInfo quarantine_bundle;
  unsigned char quarantine_full_digest[CC_SHA256_DIGEST_LENGTH];
  char quarantine_digest[DIGEST_TEXT_BYTES + 1U];
  memset(&quarantine_bundle, 0, sizeof(quarantine_bundle));
  bool quarantine_absent = quarantine_prefix_absent(storage, quarantine_prefix);
  bool quarantine_found = !quarantine_absent && find_transaction_quarantine(
    storage,
    quarantine_prefix,
    fields[1],
    fields[3],
    fields[5],
    quarantine_name,
    &quarantine_fd,
    &quarantine_identity,
    &quarantine_bundle,
    quarantine_full_digest,
    quarantine_digest
  );
  if (!quarantine_absent && !quarantine_found) goto unknown;

  if (quarantine_found) {
    char recomputed_source_digest[DIGEST_TEXT_BYTES + 1U];
    if (!path_absent_at(storage->bundles_fd, final_name) ||
        !compute_published_identity_digest(
          storage,
          final_name,
          &quarantine_identity,
          &quarantine_bundle,
          recomputed_source_digest
        ) || strcmp(recomputed_source_digest, fields[6]) != 0 ||
        !validate_create_receipt_without_source_path(storage, &quarantine_bundle, fields[6]) ||
        (transaction.quarantine_identity_digest[0] != '\0' &&
          strcmp(transaction.quarantine_identity_digest, quarantine_digest) != 0) ||
        (recovery.expected_deleted_identity_digest[0] != '\0' &&
          strcmp(recovery.expected_deleted_identity_digest, quarantine_digest) != 0) ||
        !rewrite_delete_records(
          storage,
          transaction_name,
          transaction_fd,
          &transaction,
          recovery_name,
          recovery_fd,
          &recovery,
          "UNKNOWN",
          quarantine_digest,
          NULL,
          "RECONCILING_DELETE",
          fields[7]
        )) {
      (void)close(quarantine_fd);
      goto unknown;
    }
    int terminal_fd = -1;
    Identity terminal_identity;
    BundleInfo terminal_bundle;
    unsigned char terminal_full_digest[CC_SHA256_DIGEST_LENGTH];
    char terminal_quarantine_digest[DIGEST_TEXT_BYTES + 1U];
    memset(&terminal_bundle, 0, sizeof(terminal_bundle));
    bool exact = revalidate_root(root) && revalidate_storage(root, storage) &&
      path_absent_at(storage->bundles_fd, final_name) && open_valid_quarantine(
        storage,
        fields[1],
        fields[3],
        fields[5],
        quarantine_name,
        &terminal_fd,
        &terminal_identity,
        &terminal_bundle,
        terminal_full_digest,
        terminal_quarantine_digest
      ) && same_regular_identity(&quarantine_identity, &terminal_identity) &&
      memcmp(
        quarantine_full_digest, terminal_full_digest, sizeof(terminal_full_digest)
      ) == 0 && strcmp(quarantine_digest, terminal_quarantine_digest) == 0 &&
      quarantine_path_matches(storage, quarantine_name, terminal_fd, &terminal_identity);
    if (!exact) {
      if (terminal_fd >= 0) (void)close(terminal_fd);
      (void)close(quarantine_fd);
      goto unknown;
    }
    bool unlinked = unlinkat(storage->quarantine_fd, quarantine_name, 0) == 0;
    (void)close(terminal_fd);
    (void)close(quarantine_fd);
    if (!unlinked || !commit_deleted_truth(
          root,
          storage,
          transaction_name,
          transaction_fd,
          &transaction,
          recovery_name,
          recovery_fd,
          &recovery,
          receipt_name,
          quarantine_digest,
          final_name,
          quarantine_prefix,
          fields[7]
        )) goto unknown;
    (void)close(transaction_fd);
    (void)close(recovery_fd);
    return write_delete_terminal(
      'Z', fields[1], "COMMITTED", quarantine_digest, transaction.receipt_digest, NULL
    );
  }

  if (transaction.quarantine_identity_digest[0] != '\0' &&
      strcmp(
        transaction.quarantine_identity_digest,
        recovery.expected_deleted_identity_digest
      ) == 0 && path_absent_at(storage->bundles_fd, final_name)) {
    if (!commit_deleted_truth(
          root,
          storage,
          transaction_name,
          transaction_fd,
          &transaction,
          recovery_name,
          recovery_fd,
          &recovery,
          receipt_name,
          transaction.quarantine_identity_digest,
          final_name,
          quarantine_prefix,
          fields[7]
        )) goto unknown;
    (void)close(transaction_fd);
    (void)close(recovery_fd);
    return write_delete_terminal(
      'Z', fields[1], "COMMITTED", transaction.quarantine_identity_digest,
      transaction.receipt_digest, NULL
    );
  }

  if (transaction.quarantine_identity_digest[0] == '\0' &&
      recovery.expected_deleted_identity_digest[0] == '\0') {
    int source_fd = -1;
    Identity source_identity;
    BundleInfo source_bundle;
    unsigned char source_digest[CC_SHA256_DIGEST_LENGTH];
    memset(&source_bundle, 0, sizeof(source_bundle));
    bool exact_source = prove_exact_source(
      storage,
      final_name,
      fields[3],
      fields[5],
      fields[6],
      &source_fd,
      &source_identity,
      &source_bundle,
      source_digest
    );
    if (source_fd >= 0) (void)close(source_fd);
    if (exact_source && settle_delete_uncommitted(
          root,
          storage,
          transaction_name,
          transaction_fd,
          &transaction,
          recovery_name,
          recovery_fd,
          &recovery,
          quarantine_prefix,
          fields[7],
          "RECOVERED_UNCOMMITTED"
        )) {
      (void)close(transaction_fd);
      (void)close(recovery_fd);
      return write_delete_terminal(
        'Z', fields[1], "UNCOMMITTED", NULL, NULL, "RECOVERED_UNCOMMITTED"
      );
    }
  }

unknown:
  if (transaction_fd >= 0) (void)close(transaction_fd);
  if (recovery_fd >= 0) (void)close(recovery_fd);
  return write_error('Z', "UNKNOWN") && false;
}

int main(void) {
  RootBinding root;
  StorageBinding storage;
  Stage stage;
  SealedCapture capture;
  memset(&root, 0, sizeof(root));
  memset(&storage, 0, sizeof(storage));
  memset(&stage, 0, sizeof(stage));
  memset(&capture, 0, sizeof(capture));
  root.project_fd = -1;
  storage.control_fd = -1;
  storage.bundles_fd = -1;
  storage.quarantine_fd = -1;
  stage.fd = -1;
  stage.reservation_fd = -1;

  char line[MAX_LINE_BYTES];
  LineResult first = read_line(line, sizeof(line));
  bool success = first == LINE_OK && bind_project(line, &root);
  if (!success) goto cleanup;

  while (true) {
    LineResult next = read_line(line, sizeof(line));
    if (next == LINE_EOF) {
      success = !stage.active;
      break;
    }
    if (next != LINE_OK) {
      (void)write_error('Q', next == LINE_IO ? "IO" : "PROTOCOL");
      success = false;
      break;
    }
    if (strcmp(line, "D") == 0) {
      if (storage.ready || !bind_storage(&root, &storage, false)) {
        success = false;
        break;
      }
      continue;
    }
    if (strcmp(line, "I") == 0) {
      if (storage.ready || !bind_storage(&root, &storage, true)) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'S' && line[1] == '\t') {
      if (!storage.ready || capture.active || !create_stage(line, &root, &storage, &stage)) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'G' && line[1] == '\t') {
      if (!storage.ready || !begin_sealed_capture(
            line, &root, &storage, &stage, &capture
          )) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'T' && line[1] == '\t') {
      if (!storage.ready || !begin_token_pass(line, &capture)) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'U' && line[1] == '\t') {
      if (!storage.ready || !write_token_pass_chunk(line, &capture)) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'K' && line[1] == '\t') {
      if (!storage.ready || !finish_token_pass(line, &root, &storage, &capture)) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'B' && line[1] == '\t') {
      if (!storage.ready || !finish_production_capture(
            line, &root, &storage, &stage, &capture
          )) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'W' && line[1] == '\t') {
      if (!storage.ready || !write_stage_chunk(line, &storage, &stage)) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'F' && line[1] == '\t') {
      if (!storage.ready || !finish_stage(line, &root, &storage, &stage)) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'C' && line[1] == '\t') {
      if (!storage.ready || !cancel_stage(line, &root, &storage, &stage)) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'A' && line[1] == '\t') {
      if (!storage.ready || !publish_stage(line, &root, &storage, &stage)) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'R' && line[1] == '\t') {
      if (!storage.ready || stage.active || capture.active || !reconcile_create(line, &root, &storage)) {
        success = false;
        break;
      }
      continue;
    }
    if (strcmp(line, "L") == 0) {
      if (!storage.ready || stage.active || capture.active || !list_committed(&root, &storage)) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'O' && line[1] == '\t') {
      if (!storage.ready || stage.active || capture.active ||
          !stream_committed_snapshot(line, &root, &storage)) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'Y' && line[1] == '\t') {
      if (!storage.ready || stage.active || capture.active ||
          !delete_committed_snapshot(line, &root, &storage)) {
        success = false;
        break;
      }
      continue;
    }
    if (line[0] == 'Z' && line[1] == '\t') {
      if (!storage.ready || stage.active || capture.active ||
          !reconcile_delete(line, &root, &storage)) {
        success = false;
        break;
      }
      continue;
    }
    if (strcmp(line, "X") == 0) {
      if (stage.active) {
        (void)write_error('X', "ACTIVE");
        success = false;
      } else {
        free_sealed_capture(&capture);
        success = write_line("X\tOK\n");
      }
      break;
    }
    (void)write_error('Q', "PROTOCOL");
    success = false;
    break;
  }

cleanup:
  // Never delete here. A live stage at EOF/error requires a future recovery
  // checkpoint; speculative cleanup would erase transaction truth.
  if (stage.fd >= 0 && close(stage.fd) != 0) success = false;
  if (stage.reservation_fd >= 0 && close(stage.reservation_fd) != 0) success = false;
  free_sealed_capture(&capture);
  close_storage(&storage);
  if (root.project_fd >= 0 && close(root.project_fd) != 0) success = false;
  return success ? 0 : 1;
}
