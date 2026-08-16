#define _DARWIN_C_SOURCE

// WritCraft Changes / History recovery artifact exact lifecycle helper.
//
// fd 3 is a Main-owned descriptor for the filesystem root (`/`). fd 4 is the
// already-held recovery artifact. The helper receives the canonical project
// root only in the startup bind record, walks every component with no-follow
// openat, and opens the fixed .writcraft/recovery directory descriptor-
// relatively. Lifecycle commands contain only bounded basenames, expected
// identity fields and the expected content digest; they never contain an
// absolute path or artifact bytes.
//
// Protocol:
//   P<TAB>absolute-project-path-hex
//   C<TAB>cleanup|rollback<TAB>basename<TAB>byte-length<TAB>sha256:<hex>
//     <TAB>dev<TAB>ino<TAB>uid<TAB>mode<TAB>nlink<TAB>size
//     <TAB>mtime-ns<TAB>ctime-ns
//   A<TAB>basename<TAB>quarantine<TAB>control<TAB>proof<TAB>receipt
//     <TAB>receipt-digest
//   M<TAB>CLEAR|RECONCILE<TAB>operation-id<TAB>project-id-hex
//     <TAB>marker-basename<TAB>byte-length<TAB>marker-digest
//     <TAB>marker-identity-digest<TAB>finalized-phase-digest
//     <TAB>artifact-cleanup-digest<TAB>request-digest<TAB>full identity
//   M<TAB>ACK<TAB>the same request/identity authority<TAB>control
//     <TAB>receipt<TAB>quarantine<TAB>control-digest<TAB>receipt-digest
//
// A cleanup uses immutable, hash-bound control/proof/receipt records. It moves
// the exact source with RENAME_EXCL into a private random quarantine name,
// reopens and verifies that inode and digest, then unlinks only that exact
// quarantined identity and fsyncs the recovery directory. A retry reconciles
// the immutable records and filesystem state into COMMITTED/UNCOMMITTED/
// UNKNOWN; it never lstat->unlinks a foreign name.
//
// Marker clear reuses the same trusted root and recovery descriptor. It
// publishes request-bound control/receipt records, moves only the exact held
// marker into an unpredictable no-clobber quarantine, reopens and hashes that
// inode, then unlinks/fsyncs it. RECONCILE never repeats CLEAR, and ACK removes
// only exact formal records through the same quarantine/reopen discipline.

#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define TRUSTED_ROOT_FD 3
#define HELD_ARTIFACT_FD 4
#define MAX_PATH_BYTES 4096U
#define MAX_ROOT_COMPONENTS 128U
#define MAX_LINE_BYTES 8192U
#define MAX_RECORD_BYTES 4096U
#define HASH_CHUNK_BYTES (64U * 1024U)
#define MAX_ARTIFACT_BYTES (384ULL * 1024ULL * 1024ULL)
#define MAX_MARKER_BYTES (96ULL * 1024ULL * 1024ULL)
#define MAX_PROJECT_ID_BYTES 256U
#define JOURNAL_MAGIC "WRCCHRJ2"
#define JOURNAL_REQUEST_MAGIC "WRCCHJN2"
#define JOURNAL_RESULT_MAGIC "WRCCHJO2"
#define JOURNAL_ERROR_MAGIC "WRCCHJE2"
#define JOURNAL_BASENAME "changes-history-transaction.json"
#define JOURNAL_HEAD_SCHEMA "writcraft.changes-history-marker-journal-head/v1"
#define JOURNAL_REQUEST_AUTHORITY_SCHEMA "writcraft.changes-history-marker-journal-native-request-authority/v1"
#define JOURNAL_MAX_VALUE_BYTES (96ULL * 1024ULL * 1024ULL)
#define JOURNAL_MAX_HEADER_BYTES 512U
#define JOURNAL_SLOT_CAPACITY (JOURNAL_MAX_VALUE_BYTES + JOURNAL_MAX_HEADER_BYTES + 1ULL)
#define JOURNAL_MAX_FRAME_BYTES JOURNAL_SLOT_CAPACITY
#define JOURNAL_MAX_FILE_BYTES (JOURNAL_SLOT_CAPACITY * 2ULL)

#define MARKER_BASENAME "changes-history-transaction.json"
#define MARKER_REQUEST_SCHEMA "writcraft.changes-history-native-marker-clear-request/v1"
#define MARKER_CONTROL_SCHEMA "writcraft.changes-history-native-marker-clear-control/v1"
#define MARKER_RECEIPT_SCHEMA "writcraft.changes-history-native-marker-clear-receipt/v1"
#define MARKER_RECORD_IDENTITY_SCHEMA "writcraft.changes-history-native-marker-clear-record-identity/v1"
#define MARKER_RECORD_KEY_SCHEMA "writcraft.changes-history-native-marker-clear-record-key/v1"
#define OBJECT_IDENTITY_SCHEMA "writcraft.object-identity/v1"
#define ROOT_IDENTITY_SCHEMA "writcraft.root-identity/v1"
#define ANCESTOR_IDENTITY_SCHEMA "writcraft.ancestor-identity/v1"

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
  Identity trusted_root_identity;
  Identity components[MAX_ROOT_COMPONENTS];
  Identity metadata_identity;
  Identity recovery_identity;
  int project_fd;
  int recovery_fd;
} RootBinding;

typedef struct {
  char kind[9];
  char basename[96];
  char quarantine[96];
  char control[128];
  char proof[128];
  char receipt[128];
  char sha256[72];
  char control_digest[72];
  char proof_digest[72];
  char receipt_digest[72];
  uint64_t byte_length;
  Identity identity;
} CleanupRecord;

typedef struct {
  Identity identity;
  char record_sha256[72];
  char identity_digest[72];
} MarkerRecordIdentity;

typedef struct {
  char command[10];
  char operation[53];
  char project[MAX_PROJECT_ID_BYTES + 1U];
  char marker_digest[72];
  char marker_identity_digest[72];
  char finalized_phase_digest[72];
  char artifact_cleanup_digest[72];
  char request_digest[72];
  char trusted_root_identity_digest[72];
  char project_chain_identity_digest[72];
  char recovery_identity_digest[72];
  char quarantine[96];
  char control[128];
  char receipt[128];
  char control_digest[72];
  char receipt_digest[72];
  uint64_t byte_length;
  Identity identity;
  MarkerRecordIdentity control_identity;
  MarkerRecordIdentity receipt_identity;
  bool has_record_identities;
} MarkerClearRecord;

typedef enum {
  NAME_ABSENT = 0,
  NAME_EXACT = 1,
  NAME_FOREIGN = 2,
  NAME_ERROR = 3,
} NameState;

typedef struct {
  char journal_id[54];
  char generation[21];
  char value_digest[72];
} JournalHead;

typedef struct {
  char slot;
  JournalHead head;
  char previous_value_digest[72];
  bool previous_is_null;
  char payload_sha256[72];
  uint64_t payload_length;
  size_t header_length;
} JournalFrame;

typedef struct {
  char command[9];
  char request_digest[72];
  JournalHead heads[2];
  size_t head_count;
  unsigned char *frame_bytes;
  size_t frame_length;
  JournalFrame frame;
} JournalRequest;

typedef struct {
  bool valid;
  unsigned char *bytes;
  size_t length;
  JournalFrame frame;
} JournalSlot;

static bool valid_digest(const char *value);

static bool write_line(const char *line) {
  return fputs(line, stdout) != EOF && fflush(stdout) == 0;
}

static bool write_error(char command, const char *code) {
  char line[128];
  int length = snprintf(line, sizeof(line), "%c\tERR\t%s\n", command, code);
  return length > 0 && (size_t)length < sizeof(line) && write_line(line);
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

static void prefixed_digest(const unsigned char *bytes, size_t length, char out[72]) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes, (CC_LONG)length, digest);
  memcpy(out, "sha256:", 7U);
  digest_hex(digest, out + 7U);
}

static void authority_digest(const char *schema, const char *canonical, char out[72]) {
  static const char domain[] = "writcraft-digest/v1";
  unsigned char zero = 0U;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  CC_SHA256_Update(&context, domain, (CC_LONG)(sizeof(domain) - 1U));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, schema, (CC_LONG)strlen(schema));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, canonical, (CC_LONG)strlen(canonical));
  CC_SHA256_Final(digest, &context);
  memcpy(out, "sha256:", 7U);
  digest_hex(digest, out + 7U);
}

static bool strict_utf8(const unsigned char *bytes, size_t length) {
  size_t index = 0U;
  while (index < length) {
    unsigned char first = bytes[index++];
    if (first < 0x80U) continue;
    uint32_t scalar;
    size_t remaining;
    uint32_t minimum;
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
    if (scalar < minimum || scalar > 0x10ffffU ||
        (scalar >= 0xd800U && scalar <= 0xdfffU)) return false;
  }
  return true;
}

static unsigned char nibble(char value, bool *ok);

static bool decode_marker_project(const char *hex, char out[MAX_PROJECT_ID_BYTES + 1U]) {
  size_t length = hex == NULL ? 0U : strlen(hex);
  if (length == 0U || (length & 1U) != 0U || length / 2U > MAX_PROJECT_ID_BYTES) return false;
  bool ok = true;
  for (size_t index = 0U; index < length; index += 2U) {
    unsigned char byte = (unsigned char)((nibble(hex[index], &ok) << 4U) |
      nibble(hex[index + 1U], &ok));
    if (!ok || byte < 0x20U) return false;
    out[index / 2U] = (char)byte;
  }
  out[length / 2U] = '\0';
  return strict_utf8((const unsigned char *)out, length / 2U);
}

static bool valid_marker_operation(const char *value) {
  if (value == NULL || strlen(value) != 52U || strncmp(value, "chr_", 4U) != 0) return false;
  for (size_t index = 4U; index < 52U; index += 1U) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}

static bool json_escape(const char *value, char *out, size_t capacity) {
  size_t offset = 0U;
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != 0U; cursor += 1U) {
    if (*cursor == '"' || *cursor == '\\') {
      if (offset + 2U >= capacity) return false;
      out[offset++] = '\\';
      out[offset++] = (char)*cursor;
    } else {
      if (offset + 1U >= capacity) return false;
      out[offset++] = (char)*cursor;
    }
  }
  out[offset] = '\0';
  return true;
}

static bool root_identity_authority(const Identity *identity, char out[72]) {
  char canonical[1024];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX
    ",\"schema\":\"" ROOT_IDENTITY_SCHEMA "\",\"uid\":%" PRIuMAX "}",
    identity->dev, identity->ino, identity->mode & 07777U, identity->uid);
  if (length <= 0 || (size_t)length >= sizeof(canonical)) return false;
  authority_digest(ROOT_IDENTITY_SCHEMA, canonical, out);
  return true;
}

static bool append_ancestor_component(
  char *canonical, size_t capacity, size_t *offset, const char *name, const Identity *identity,
  bool comma
) {
  if (name == NULL) return false;
  char name_digest[72];
  prefixed_digest((const unsigned char *)name, strlen(name), name_digest);
  int length = snprintf(canonical + *offset, capacity - *offset,
    "%s{\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX
    ",\"nameSha256\":\"%s\",\"uid\":%" PRIuMAX "}",
    comma ? "," : "", identity->dev, identity->ino, identity->mode & 07777U,
    name_digest, identity->uid);
  if (length <= 0 || (size_t)length >= capacity - *offset) return false;
  *offset += (size_t)length;
  return true;
}

static bool project_chain_authority(const RootBinding *root, char out[72]) {
  char canonical[65536];
  size_t offset = 0U;
  int length = snprintf(canonical, sizeof(canonical), "{\"components\":[");
  if (length <= 0 || (size_t)length >= sizeof(canonical)) return false;
  offset = (size_t)length;
  char copy[MAX_PATH_BYTES + 1U];
  memcpy(copy, root->path + 1U, strlen(root->path));
  char *segment = copy;
  for (size_t index = 0U; index < root->component_count; index += 1U) {
    char *next = strchr(segment, '/');
    if (next != NULL) *next = '\0';
    if (!append_ancestor_component(
        canonical, sizeof(canonical), &offset, segment, &root->components[index], index != 0U
      )) return false;
    segment = next == NULL ? NULL : next + 1U;
  }
  if (!append_ancestor_component(
      canonical, sizeof(canonical), &offset, ".writcraft", &root->metadata_identity, true
    )) return false;
  length = snprintf(canonical + offset, sizeof(canonical) - offset,
    "],\"schema\":\"" ANCESTOR_IDENTITY_SCHEMA "\"}");
  if (length <= 0 || (size_t)length >= sizeof(canonical) - offset) return false;
  authority_digest(ANCESTOR_IDENTITY_SCHEMA, canonical, out);
  return true;
}

static bool marker_root_authority_matches(
  const RootBinding *root, const MarkerClearRecord *record
) {
  char trusted[72];
  char project[72];
  char recovery[72];
  return root_identity_authority(&root->trusted_root_identity, trusted) &&
    project_chain_authority(root, project) &&
    root_identity_authority(&root->recovery_identity, recovery) &&
    strcmp(trusted, record->trusted_root_identity_digest) == 0 &&
    strcmp(project, record->project_chain_identity_digest) == 0 &&
    strcmp(recovery, record->recovery_identity_digest) == 0;
}

static bool marker_request_authority(MarkerClearRecord *record) {
  char project[(MAX_PROJECT_ID_BYTES * 2U) + 1U];
  char canonical[4096];
  if (!json_escape(record->project, project, sizeof(project))) return false;
  int length = snprintf(canonical, sizeof(canonical),
    "{\"artifactCleanupDigest\":\"%s\",\"finalizedPhaseDigest\":\"%s\""
    ",\"markerBasename\":\"" MARKER_BASENAME "\",\"markerByteLength\":%" PRIu64
    ",\"markerDigest\":\"%s\",\"markerIdentityDigest\":\"%s\""
    ",\"operationId\":\"%s\",\"projectChainIdentityDigest\":\"%s\""
    ",\"projectId\":\"%s\",\"recoveryIdentityDigest\":\"%s\""
    ",\"schema\":\"" MARKER_REQUEST_SCHEMA "\",\"trustedRootIdentityDigest\":\"%s\"}",
    record->artifact_cleanup_digest, record->finalized_phase_digest, record->byte_length,
    record->marker_digest, record->marker_identity_digest, record->operation,
    record->project_chain_identity_digest, project, record->recovery_identity_digest,
    record->trusted_root_identity_digest);
  if (length <= 0 || (size_t)length >= sizeof(canonical)) return false;
  char request_digest[72];
  authority_digest(MARKER_REQUEST_SCHEMA, canonical, request_digest);
  if (strcmp(request_digest, record->request_digest) != 0) return false;

  length = snprintf(canonical, sizeof(canonical),
    "{\"contentSha256\":\"%s\",\"ctimeNs\":\"%" PRIdMAX "\",\"dev\":\"%" PRIuMAX
    "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX ",\"mtimeNs\":\"%" PRIdMAX
    "\",\"nlink\":%" PRIuMAX ",\"schema\":\"" OBJECT_IDENTITY_SCHEMA
    "\",\"size\":\"%" PRIuMAX "\",\"uid\":%" PRIuMAX "}",
    record->marker_digest, record->identity.ctime_ns, record->identity.dev,
    record->identity.ino, record->identity.mode, record->identity.mtime_ns,
    record->identity.nlink, record->identity.size, record->identity.uid);
  if (length <= 0 || (size_t)length >= sizeof(canonical)) return false;
  char identity_digest[72];
  authority_digest(OBJECT_IDENTITY_SCHEMA, canonical, identity_digest);
  if (strcmp(identity_digest, record->marker_identity_digest) != 0) return false;

  length = snprintf(canonical, sizeof(canonical),
    "{\"operationId\":\"%s\",\"projectId\":\"%s\",\"requestDigest\":\"%s\""
    ",\"schema\":\"" MARKER_RECORD_KEY_SCHEMA "\"}",
    record->operation, project, record->request_digest);
  if (length <= 0 || (size_t)length >= sizeof(canonical)) return false;
  char key_digest[72];
  authority_digest(MARKER_RECORD_KEY_SCHEMA, canonical, key_digest);
  int a = snprintf(record->control, sizeof(record->control),
    ".changes-history-marker-clear-control.%s", key_digest + 7U);
  int b = snprintf(record->receipt, sizeof(record->receipt),
    ".changes-history-marker-clear-receipt.%s", key_digest + 7U);
  return a > 0 && (size_t)a < sizeof(record->control) &&
    b > 0 && (size_t)b < sizeof(record->receipt);
}

static bool marker_control_authority(MarkerClearRecord *record) {
  char project[(MAX_PROJECT_ID_BYTES * 2U) + 1U];
  char canonical[4096];
  if (!json_escape(record->project, project, sizeof(project))) return false;
  int length = snprintf(canonical, sizeof(canonical),
    "{\"artifactCleanupDigest\":\"%s\",\"finalizedPhaseDigest\":\"%s\""
    ",\"markerBasename\":\"" MARKER_BASENAME "\",\"markerByteLength\":%" PRIu64
    ",\"markerDigest\":\"%s\",\"markerIdentityDigest\":\"%s\""
    ",\"operationId\":\"%s\",\"projectChainIdentityDigest\":\"%s\""
    ",\"projectId\":\"%s\",\"quarantineBasename\":\"%s\""
    ",\"recoveryIdentityDigest\":\"%s\",\"requestDigest\":\"%s\""
    ",\"schema\":\"" MARKER_CONTROL_SCHEMA "\",\"trustedRootIdentityDigest\":\"%s\"}",
    record->artifact_cleanup_digest, record->finalized_phase_digest, record->byte_length,
    record->marker_digest, record->marker_identity_digest, record->operation,
    record->project_chain_identity_digest, project, record->quarantine,
    record->recovery_identity_digest, record->request_digest,
    record->trusted_root_identity_digest);
  if (length <= 0 || (size_t)length >= sizeof(canonical)) return false;
  authority_digest(MARKER_CONTROL_SCHEMA, canonical, record->control_digest);
  return true;
}

static bool marker_receipt_authority(MarkerClearRecord *record) {
  char canonical[2048];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"controlDigest\":\"%s\",\"markerDigest\":\"%s\",\"markerIdentityDigest\":\"%s\""
    ",\"markerRemoved\":true,\"operationId\":\"%s\",\"quarantineBasename\":\"%s\""
    ",\"recoveryFsyncComplete\":true,\"requestDigest\":\"%s\",\"schema\":\""
    MARKER_RECEIPT_SCHEMA "\"}", record->control_digest, record->marker_digest,
    record->marker_identity_digest, record->operation, record->quarantine, record->request_digest);
  if (length <= 0 || (size_t)length >= sizeof(canonical)) return false;
  authority_digest(MARKER_RECEIPT_SCHEMA, canonical, record->receipt_digest);
  return true;
}

static bool marker_record_identity_authority(MarkerRecordIdentity *record) {
  if (record->identity.mtime_ns < 0 || record->identity.ctime_ns < 0 ||
      (record->identity.mode & 07777U) != 0600U || record->identity.nlink != 1U ||
      !valid_digest(record->record_sha256)) return false;
  char canonical[2048];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"ctimeNs\":\"%" PRIdMAX "\",\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX
    "\",\"mode\":%" PRIuMAX ",\"mtimeNs\":\"%" PRIdMAX "\",\"nlink\":%" PRIuMAX
    ",\"recordSha256\":\"%s\",\"schema\":\"" MARKER_RECORD_IDENTITY_SCHEMA
    "\",\"size\":\"%" PRIuMAX "\",\"uid\":%" PRIuMAX "}",
    record->identity.ctime_ns, record->identity.dev, record->identity.ino,
    record->identity.mode & 07777U, record->identity.mtime_ns, record->identity.nlink,
    record->record_sha256, record->identity.size, record->identity.uid);
  if (length <= 0 || (size_t)length >= sizeof(canonical)) return false;
  char digest[72];
  authority_digest(MARKER_RECORD_IDENTITY_SCHEMA, canonical, digest);
  if (record->identity_digest[0] == '\0') {
    memcpy(record->identity_digest, digest, sizeof(record->identity_digest));
    return true;
  }
  return strcmp(record->identity_digest, digest) == 0;
}

static bool timespec_ns(struct timespec value, intmax_t *out) {
  if (value.tv_nsec < 0 || value.tv_nsec >= 1000000000L) return false;
  if (value.tv_sec > (INTMAX_MAX - value.tv_nsec) / 1000000000L ||
      value.tv_sec < (INTMAX_MIN + value.tv_nsec) / 1000000000L) return false;
  *out = ((intmax_t)value.tv_sec * 1000000000L) + value.tv_nsec;
  return true;
}

static bool identity_from_stat(const struct stat *value, Identity *out) {
  if (value->st_size < 0 || !timespec_ns(value->st_mtimespec, &out->mtime_ns) ||
      !timespec_ns(value->st_ctimespec, &out->ctime_ns)) return false;
  out->dev = (uintmax_t)value->st_dev;
  out->ino = (uintmax_t)value->st_ino;
  out->uid = (uintmax_t)value->st_uid;
  out->mode = (uintmax_t)value->st_mode;
  out->nlink = (uintmax_t)value->st_nlink;
  out->size = (uintmax_t)value->st_size;
  return true;
}

static bool same_directory(const Identity *left, const Identity *right) {
  return left->dev == right->dev && left->ino == right->ino &&
    left->uid == right->uid && left->mode == right->mode &&
    S_ISDIR((mode_t)left->mode) && S_ISDIR((mode_t)right->mode);
}

static bool same_regular(const Identity *left, const Identity *right) {
  return left->dev == right->dev && left->ino == right->ino &&
    left->uid == right->uid && left->mode == right->mode &&
    left->nlink == right->nlink && left->size == right->size &&
    left->mtime_ns == right->mtime_ns && left->ctime_ns == right->ctime_ns &&
    S_ISREG((mode_t)left->mode) && S_ISREG((mode_t)right->mode);
}

static bool same_bound_object(const Identity *left, const Identity *right) {
  return left->dev == right->dev && left->ino == right->ino &&
    left->uid == right->uid && left->mode == right->mode &&
    left->nlink == right->nlink && left->size == right->size &&
    S_ISREG((mode_t)left->mode) && S_ISREG((mode_t)right->mode);
}

static bool valid_component(const char *value) {
  return value != NULL && value[0] != '\0' && strcmp(value, ".") != 0 &&
    strcmp(value, "..") != 0 && strchr(value, '/') == NULL;
}

static bool valid_digest(const char *value) {
  if (value == NULL || strlen(value) != 71U || strncmp(value, "sha256:", 7U) != 0) return false;
  for (size_t index = 7U; index < 71U; index += 1U) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}

static bool valid_artifact_basename(const char *value) {
  static const char prefix[] = "changes-history-chr_";
  static const char suffix[] = ".bin";
  size_t length = value == NULL ? 0U : strlen(value);
  if (length != (sizeof(prefix) - 1U) + 48U + (sizeof(suffix) - 1U) ||
      strncmp(value, prefix, sizeof(prefix) - 1U) != 0 ||
      strcmp(value + length - (sizeof(suffix) - 1U), suffix) != 0) return false;
  for (size_t index = sizeof(prefix) - 1U; index < (sizeof(prefix) - 1U) + 48U; index += 1U) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}

static bool valid_generated_name(const char *value, const char *prefix, size_t hex_length) {
  size_t prefix_length = strlen(prefix);
  size_t length = value == NULL ? 0U : strlen(value);
  if (length != prefix_length + hex_length || strncmp(value, prefix, prefix_length) != 0) return false;
  for (size_t index = prefix_length; index < length; index += 1U) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}

static bool parse_uint(const char *value, uintmax_t maximum, uintmax_t *out) {
  if (value == NULL || value[0] == '\0' || (value[0] == '0' && value[1] != '\0')) return false;
  for (const char *cursor = value; *cursor != '\0'; cursor += 1U) {
    if (*cursor < '0' || *cursor > '9') return false;
  }
  errno = 0;
  char *end = NULL;
  uintmax_t parsed = strtoumax(value, &end, 10);
  if (errno == ERANGE || end == NULL || *end != '\0' || parsed > maximum) return false;
  *out = parsed;
  return true;
}

static bool parse_int(const char *value, intmax_t *out) {
  if (value == NULL || value[0] == '\0' ||
      (value[0] == '0' && value[1] != '\0') ||
      (value[0] == '-' && (value[1] == '\0' || value[1] == '0'))) return false;
  const char *cursor = value[0] == '-' ? value + 1 : value;
  for (; *cursor != '\0'; cursor += 1U) if (*cursor < '0' || *cursor > '9') return false;
  errno = 0;
  char *end = NULL;
  intmax_t parsed = strtoimax(value, &end, 10);
  if (errno == ERANGE || end == NULL || *end != '\0') return false;
  *out = parsed;
  return true;
}

static bool split_fields(char *line, char **fields, size_t capacity, size_t *count_out) {
  if (line == NULL || line[0] == '\0' || capacity == 0U) return false;
  size_t count = 1U;
  fields[0] = line;
  for (char *cursor = line; *cursor != '\0'; cursor += 1U) {
    if (*cursor != '\t') continue;
    *cursor = '\0';
    if (count >= capacity) return false;
    fields[count++] = cursor + 1U;
  }
  for (size_t index = 0U; index < count; index += 1U) if (fields[index][0] == '\0') return false;
  *count_out = count;
  return true;
}

static unsigned char nibble(char value, bool *ok) {
  if (value >= '0' && value <= '9') return (unsigned char)(value - '0');
  if (value >= 'a' && value <= 'f') return (unsigned char)(10 + value - 'a');
  *ok = false;
  return 0U;
}

static bool decode_project_path(const char *hex, char *out, size_t capacity) {
  size_t length = strlen(hex);
  if (length == 0U || (length % 2U) != 0U || (length / 2U) >= capacity) return false;
  bool ok = true;
  for (size_t index = 0U; index < length; index += 2U) {
    out[index / 2U] = (char)((nibble(hex[index], &ok) << 4U) | nibble(hex[index + 1U], &ok));
    if (!ok || out[index / 2U] == '\0') return false;
  }
  out[length / 2U] = '\0';
  return out[0] == '/' && out[1] != '\0';
}

static bool count_components(const char *path, size_t *count_out) {
  if (strlen(path) > MAX_PATH_BYTES) return false;
  char copy[MAX_PATH_BYTES + 1U];
  memcpy(copy, path + 1U, strlen(path));
  size_t count = 0U;
  char *segment = copy;
  while (segment != NULL) {
    char *next = strchr(segment, '/');
    if (next != NULL) *next = '\0';
    if (!valid_component(segment) || count >= MAX_ROOT_COMPONENTS) return false;
    count += 1U;
    segment = next == NULL ? NULL : next + 1U;
  }
  *count_out = count;
  return count > 0U;
}

static bool trusted_root_ready(Identity *identity_out) {
  struct stat stat_value;
  Identity identity;
  int flags = fcntl(TRUSTED_ROOT_FD, F_GETFL);
  if (flags < 0 || (flags & O_ACCMODE) != O_RDONLY ||
      fstat(TRUSTED_ROOT_FD, &stat_value) != 0 || !identity_from_stat(&stat_value, &identity) ||
      !S_ISDIR(stat_value.st_mode)) return false;
  *identity_out = identity;
  return true;
}

static bool walk_root(RootBinding *binding, bool capture, int *project_out) {
  int current = fcntl(TRUSTED_ROOT_FD, F_DUPFD_CLOEXEC, 0);
  if (current < 0) return false;
  char copy[MAX_PATH_BYTES + 1U];
  memcpy(copy, binding->path + 1U, strlen(binding->path));
  char *segment = copy;
  for (size_t index = 0U; index < binding->component_count; index += 1U) {
    char *next = strchr(segment, '/');
    if (next != NULL) *next = '\0';
    int child = openat(current, segment, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    (void)close(current);
    if (child < 0) return false;
    struct stat stat_value;
    Identity identity;
    if (fstat(child, &stat_value) != 0 || !identity_from_stat(&stat_value, &identity) ||
        !S_ISDIR(stat_value.st_mode) || (!capture && !same_directory(&identity, &binding->components[index]))) {
      (void)close(child);
      return false;
    }
    if (capture) binding->components[index] = identity;
    current = child;
    segment = next == NULL ? NULL : next + 1U;
  }
  *project_out = current;
  return true;
}

static bool open_private_directory(int parent, const char *name, int *fd_out, Identity *identity_out) {
  int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat stat_value;
  Identity identity;
  int flags = fcntl(fd, F_GETFL);
  bool valid = flags >= 0 && (flags & O_ACCMODE) == O_RDONLY &&
    fstat(fd, &stat_value) == 0 && identity_from_stat(&stat_value, &identity) &&
    S_ISDIR(stat_value.st_mode) && stat_value.st_uid == geteuid() &&
    (stat_value.st_mode & 0777) == 0700;
  if (!valid) {
    (void)close(fd);
    return false;
  }
  *fd_out = fd;
  *identity_out = identity;
  return true;
}

static bool open_owned_directory(int parent, const char *name, int *fd_out, Identity *identity_out) {
  int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat stat_value;
  Identity identity;
  int flags = fcntl(fd, F_GETFL);
  bool valid = flags >= 0 && (flags & O_ACCMODE) == O_RDONLY &&
    fstat(fd, &stat_value) == 0 && identity_from_stat(&stat_value, &identity) &&
    S_ISDIR(stat_value.st_mode) && stat_value.st_uid == geteuid() &&
    (stat_value.st_mode & 0022) == 0;
  if (!valid) {
    (void)close(fd);
    return false;
  }
  *fd_out = fd;
  *identity_out = identity;
  return true;
}

static bool open_recovery_tree(RootBinding *binding, bool capture) {
  int project = -1;
  if (!walk_root(binding, capture, &project)) return false;
  int metadata = -1;
  int recovery = -1;
  Identity metadata_identity;
  Identity recovery_identity;
  bool valid = open_owned_directory(project, ".writcraft", &metadata, &metadata_identity) &&
    open_private_directory(metadata, "recovery", &recovery, &recovery_identity);
  if (metadata >= 0) (void)close(metadata);
  (void)close(project);
  if (!valid || (!capture && (!same_directory(&metadata_identity, &binding->metadata_identity) ||
      !same_directory(&recovery_identity, &binding->recovery_identity)))) {
    if (recovery >= 0) (void)close(recovery);
    return false;
  }
  if (capture) {
    binding->metadata_identity = metadata_identity;
    binding->recovery_identity = recovery_identity;
    binding->recovery_fd = recovery;
  } else {
    (void)close(recovery);
  }
  return true;
}

static bool bind_project(char *line, RootBinding *binding) {
  char *fields[2];
  size_t count = 0U;
  if (!split_fields(line, fields, 2U, &count) || count != 2U || strcmp(fields[0], "P") != 0 ||
      !decode_project_path(fields[1], binding->path, sizeof(binding->path)) ||
      !count_components(binding->path, &binding->component_count)) return write_error('P', "PROTOCOL") && false;
  if (!trusted_root_ready(&binding->trusted_root_identity) ||
      !open_recovery_tree(binding, true)) return write_error('P', "ROOT") && false;
  return write_line("P\tOK\n");
}

static bool revalidate_tree(RootBinding *binding) {
  Identity trusted_root_identity;
  return trusted_root_ready(&trusted_root_identity) &&
    same_directory(&trusted_root_identity, &binding->trusted_root_identity) &&
    open_recovery_tree(binding, false);
}

static bool hash_fd_stable(int fd, Identity *identity_out, char digest_out[72]) {
  struct stat before_stat;
  Identity before;
  if (fstat(fd, &before_stat) != 0 || !identity_from_stat(&before_stat, &before) ||
      !S_ISREG(before_stat.st_mode) || before.size > MAX_ARTIFACT_BYTES) return false;
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  unsigned char buffer[HASH_CHUNK_BYTES];
  uintmax_t offset = 0U;
  while (offset < before.size) {
    size_t wanted = before.size - offset > sizeof(buffer) ? sizeof(buffer) : (size_t)(before.size - offset);
    ssize_t count = pread(fd, buffer, wanted, (off_t)offset);
    if (count <= 0) return false;
    CC_SHA256_Update(&context, buffer, (CC_LONG)count);
    offset += (uintmax_t)count;
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  struct stat after_stat;
  Identity after;
  if (fstat(fd, &after_stat) != 0 || !identity_from_stat(&after_stat, &after) ||
      !same_regular(&before, &after)) return false;
  memcpy(digest_out, "sha256:", 7U);
  digest_hex(digest, digest_out + 7U);
  *identity_out = before;
  return true;
}

static NameState open_name_exact(
  int directory, const char *name, const Identity *expected, const char *expected_digest, int *fd_out
) {
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? NAME_ABSENT : NAME_ERROR;
  Identity identity;
  char digest[72];
  bool exact = hash_fd_stable(fd, &identity, digest) && same_bound_object(&identity, expected) &&
    strcmp(digest, expected_digest) == 0;
  if (!exact) {
    (void)close(fd);
    return NAME_FOREIGN;
  }
  *fd_out = fd;
  return NAME_EXACT;
}

static bool path_matches_fd(int directory, const char *name, int fd) {
  struct stat path_stat;
  struct stat held_stat;
  Identity path_identity;
  Identity held_identity;
  return fstatat(directory, name, &path_stat, AT_SYMLINK_NOFOLLOW) == 0 &&
    fstat(fd, &held_stat) == 0 && identity_from_stat(&path_stat, &path_identity) &&
    identity_from_stat(&held_stat, &held_identity) && same_regular(&path_identity, &held_identity);
}

static bool immutable_record(int directory, const char *name, const char *bytes) {
  size_t length = strlen(bytes);
  if (length == 0U || length > MAX_RECORD_BYTES) return false;
  int fd = openat(directory, name, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) {
    if (errno != EEXIST) return false;
    fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return false;
    struct stat stat_value;
    char existing[MAX_RECORD_BYTES + 1U];
    ssize_t count = pread(fd, existing, MAX_RECORD_BYTES + 1U, 0);
    bool valid = fstat(fd, &stat_value) == 0 && S_ISREG(stat_value.st_mode) &&
      stat_value.st_uid == geteuid() && (stat_value.st_mode & 0777) == 0600 &&
      stat_value.st_nlink == 1 && count == (ssize_t)length &&
      memcmp(existing, bytes, length) == 0;
    (void)close(fd);
    return valid;
  }
  size_t offset = 0U;
  while (offset < length) {
    ssize_t count = write(fd, bytes + offset, length - offset);
    if (count <= 0) {
      (void)close(fd);
      return false;
    }
    offset += (size_t)count;
  }
  bool valid = fsync(fd) == 0;
  (void)close(fd);
  return valid && fsync(directory) == 0;
}

static bool record_present_exact(int directory, const char *name, const char *bytes, bool *present) {
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT) { *present = false; return true; }
    return false;
  }
  size_t length = strlen(bytes);
  char existing[MAX_RECORD_BYTES + 1U];
  struct stat stat_value;
  ssize_t count = pread(fd, existing, MAX_RECORD_BYTES + 1U, 0);
  bool valid = fstat(fd, &stat_value) == 0 && S_ISREG(stat_value.st_mode) &&
    stat_value.st_uid == geteuid() && (stat_value.st_mode & 0777) == 0600 &&
    stat_value.st_nlink == 1 && count == (ssize_t)length && memcmp(existing, bytes, length) == 0;
  (void)close(fd);
  *present = true;
  return valid;
}

static void name_digest(const CleanupRecord *record, char hex[65]) {
  char canonical[1024];
  int length = snprintf(
    canonical, sizeof(canonical), "%s|%s|%s|%" PRIu64 "|%" PRIuMAX "|%" PRIuMAX,
    record->kind, record->basename, record->sha256, record->byte_length,
    record->identity.dev, record->identity.ino
  );
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(canonical, (CC_LONG)length, digest);
  digest_hex(digest, hex);
}

static bool random_quarantine(char out[96]) {
  unsigned char random[16];
  char hex[33];
  arc4random_buf(random, sizeof(random));
  static const char alphabet[] = "0123456789abcdef";
  for (size_t index = 0U; index < sizeof(random); index += 1U) {
    hex[index * 2U] = alphabet[random[index] >> 4U];
    hex[(index * 2U) + 1U] = alphabet[random[index] & 0x0fU];
  }
  hex[32] = '\0';
  int length = snprintf(out, 96U, ".changes-history-cleanup.%s", hex);
  return length > 0 && length < 96;
}

static bool build_record_names(CleanupRecord *record) {
  char hex[65];
  name_digest(record, hex);
  int a = snprintf(record->control, sizeof(record->control), ".changes-history-cleanup-control.%s", hex);
  int b = snprintf(record->proof, sizeof(record->proof), ".changes-history-cleanup-proof.%s", hex);
  int c = snprintf(record->receipt, sizeof(record->receipt), ".changes-history-cleanup-receipt.%s", hex);
  return a > 0 && (size_t)a < sizeof(record->control) &&
    b > 0 && (size_t)b < sizeof(record->proof) &&
    c > 0 && (size_t)c < sizeof(record->receipt);
}

static bool make_control(const CleanupRecord *record, char out[MAX_RECORD_BYTES + 1U]) {
  char body[MAX_RECORD_BYTES + 1U];
  int length = snprintf(
    body, sizeof(body),
    "WRCCHAC1\t%s\t%s\t%s\t%" PRIu64 "\t%s\t%" PRIuMAX "\t%" PRIuMAX
    "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIdMAX "\t%" PRIdMAX,
    record->kind, record->basename, record->quarantine, record->byte_length, record->sha256,
    record->identity.dev, record->identity.ino, record->identity.uid, record->identity.mode,
    record->identity.nlink, record->identity.size, record->identity.mtime_ns, record->identity.ctime_ns
  );
  if (length <= 0 || (size_t)length >= sizeof(body)) return false;
  char digest[72];
  prefixed_digest((const unsigned char *)body, (size_t)length, digest);
  int final = snprintf(out, MAX_RECORD_BYTES + 1U, "%s\t%s\n", body, digest);
  return final > 0 && final <= (int)MAX_RECORD_BYTES;
}

static bool make_proof(const CleanupRecord *record, char out[MAX_RECORD_BYTES + 1U]) {
  char body[1024];
  int length = snprintf(body, sizeof(body), "WRCCHAQ1\t%s\t%s\t%s\t%s\t%" PRIu64,
    record->control_digest, record->basename, record->quarantine, record->sha256,
    record->byte_length);
  if (length <= 0 || (size_t)length >= sizeof(body)) return false;
  char digest[72];
  prefixed_digest((const unsigned char *)body, (size_t)length, digest);
  int final = snprintf(out, MAX_RECORD_BYTES + 1U, "%s\t%s\n", body, digest);
  return final > 0 && final <= (int)MAX_RECORD_BYTES;
}

static bool make_receipt(const CleanupRecord *record, char out[MAX_RECORD_BYTES + 1U]) {
  char body[1024];
  int length = snprintf(body, sizeof(body), "WRCCHAR1\t%s\t%s\t%s\t%s\t%s\t%" PRIu64,
    record->control_digest, record->proof_digest, record->basename, record->quarantine,
    record->sha256, record->byte_length);
  if (length <= 0 || (size_t)length >= sizeof(body)) return false;
  char digest[72];
  prefixed_digest((const unsigned char *)body, (size_t)length, digest);
  int final = snprintf(out, MAX_RECORD_BYTES + 1U, "%s\t%s\n", body, digest);
  return final > 0 && final <= (int)MAX_RECORD_BYTES;
}

static void extract_record_digest(const char *record, char out[72]) {
  size_t length = strlen(record);
  memcpy(out, record + length - 72U, 71U);
  out[71] = '\0';
}

static bool read_record_bytes(int directory, const char *name, char out[MAX_RECORD_BYTES + 1U]) {
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat stat_value;
  ssize_t length = pread(fd, out, MAX_RECORD_BYTES + 1U, 0);
  bool valid = fstat(fd, &stat_value) == 0 && S_ISREG(stat_value.st_mode) &&
    stat_value.st_uid == geteuid() && (stat_value.st_mode & 0777) == 0600 &&
    stat_value.st_nlink == 1 && length > 73 && length <= (ssize_t)MAX_RECORD_BYTES &&
    stat_value.st_size == length;
  (void)close(fd);
  if (!valid) return false;
  out[length] = '\0';
  return true;
}

static bool self_digest_valid(const char *bytes, char digest_out[72]) {
  size_t length = strlen(bytes);
  if (length <= 73U || bytes[length - 1U] != '\n' || bytes[length - 73U] != '\t') return false;
  char actual[72];
  prefixed_digest((const unsigned char *)bytes, length - 73U, actual);
  extract_record_digest(bytes, digest_out);
  return valid_digest(digest_out) && strcmp(actual, digest_out) == 0;
}

static bool load_control(int directory, CleanupRecord *record, char bytes[MAX_RECORD_BYTES + 1U]) {
  if (!read_record_bytes(directory, record->control, bytes)) return false;
  char digest[72];
  if (!self_digest_valid(bytes, digest)) return false;
  char copy[MAX_RECORD_BYTES + 1U];
  memcpy(copy, bytes, strlen(bytes) + 1U);
  copy[strlen(copy) - 1U] = '\0';
  char *fields[15];
  size_t count = 0U;
  uintmax_t parsed = 0U;
  intmax_t signed_value = 0;
  if (!split_fields(copy, fields, 15U, &count) || count != 15U ||
      strcmp(fields[0], "WRCCHAC1") != 0 || strcmp(fields[1], record->kind) != 0 ||
      strcmp(fields[2], record->basename) != 0 ||
      !valid_generated_name(fields[3], ".changes-history-cleanup.", 32U) ||
      !parse_uint(fields[4], MAX_ARTIFACT_BYTES, &parsed) || parsed != record->byte_length ||
      strcmp(fields[5], record->sha256) != 0) return false;
  const uintmax_t expected_unsigned[6] = {
    record->identity.dev, record->identity.ino, record->identity.uid,
    record->identity.mode, record->identity.nlink, record->identity.size,
  };
  for (size_t index = 0U; index < 6U; index += 1U) {
    if (!parse_uint(fields[6U + index], UINTMAX_MAX, &parsed) || parsed != expected_unsigned[index]) return false;
  }
  if (!parse_int(fields[12], &signed_value)) return false;
  record->identity.mtime_ns = signed_value;
  if (!parse_int(fields[13], &signed_value)) return false;
  record->identity.ctime_ns = signed_value;
  if (strcmp(fields[14], digest) != 0) return false;
  memcpy(record->quarantine, fields[3], strlen(fields[3]) + 1U);
  memcpy(record->control_digest, digest, 72U);
  return true;
}

static bool parse_control_any(const char *source, CleanupRecord *record) {
  char digest[72];
  if (!self_digest_valid(source, digest)) return false;
  char copy[MAX_RECORD_BYTES + 1U];
  memcpy(copy, source, strlen(source) + 1U);
  copy[strlen(copy) - 1U] = '\0';
  char *fields[15];
  size_t count = 0U;
  uintmax_t parsed = 0U;
  if (!split_fields(copy, fields, 15U, &count) || count != 15U ||
      strcmp(fields[0], "WRCCHAC1") != 0 ||
      (strcmp(fields[1], "cleanup") != 0 && strcmp(fields[1], "rollback") != 0) ||
      !valid_artifact_basename(fields[2]) ||
      !valid_generated_name(fields[3], ".changes-history-cleanup.", 32U) ||
      !parse_uint(fields[4], MAX_ARTIFACT_BYTES, &parsed) || !valid_digest(fields[5])) return false;
  memcpy(record->kind, fields[1], strlen(fields[1]) + 1U);
  memcpy(record->basename, fields[2], strlen(fields[2]) + 1U);
  memcpy(record->quarantine, fields[3], strlen(fields[3]) + 1U);
  record->byte_length = (uint64_t)parsed;
  memcpy(record->sha256, fields[5], 72U);
  uintmax_t *unsigned_targets[6] = {
    &record->identity.dev, &record->identity.ino, &record->identity.uid,
    &record->identity.mode, &record->identity.nlink, &record->identity.size,
  };
  for (size_t index = 0U; index < 6U; index += 1U) {
    if (!parse_uint(fields[6U + index], UINTMAX_MAX, unsigned_targets[index])) return false;
  }
  if (!parse_int(fields[12], &record->identity.mtime_ns) ||
      !parse_int(fields[13], &record->identity.ctime_ns) || strcmp(fields[14], digest) != 0 ||
      record->identity.size != record->byte_length || record->identity.nlink != 1U ||
      record->identity.uid != (uintmax_t)geteuid() || !S_ISREG((mode_t)record->identity.mode) ||
      !build_record_names(record)) return false;
  memcpy(record->control_digest, digest, 72U);
  return true;
}

static bool parse_cleanup(char *line, CleanupRecord *record) {
  char *fields[13];
  size_t count = 0U;
  uintmax_t value = 0U;
  if (!split_fields(line, fields, 13U, &count) || count != 13U || strcmp(fields[0], "C") != 0 ||
      (strcmp(fields[1], "cleanup") != 0 && strcmp(fields[1], "rollback") != 0) ||
      !valid_artifact_basename(fields[2]) || !parse_uint(fields[3], MAX_ARTIFACT_BYTES, &value) ||
      !valid_digest(fields[4])) return false;
  memcpy(record->kind, fields[1], strlen(fields[1]) + 1U);
  memcpy(record->basename, fields[2], strlen(fields[2]) + 1U);
  record->byte_length = (uint64_t)value;
  memcpy(record->sha256, fields[4], 72U);
  if (!parse_uint(fields[5], UINTMAX_MAX, &record->identity.dev) ||
      !parse_uint(fields[6], UINTMAX_MAX, &record->identity.ino) ||
      !parse_uint(fields[7], UINTMAX_MAX, &record->identity.uid) ||
      !parse_uint(fields[8], UINTMAX_MAX, &record->identity.mode) ||
      !parse_uint(fields[9], UINTMAX_MAX, &record->identity.nlink) ||
      !parse_uint(fields[10], UINTMAX_MAX, &record->identity.size) ||
      !parse_int(fields[11], &record->identity.mtime_ns) ||
      !parse_int(fields[12], &record->identity.ctime_ns) ||
      record->identity.size != record->byte_length || record->identity.uid != (uintmax_t)geteuid() ||
      record->identity.nlink != 1U || !S_ISREG((mode_t)record->identity.mode)) return false;
  return build_record_names(record);
}

static bool cleanup_exact(RootBinding *root, CleanupRecord *record) {
  int held_flags = fcntl(HELD_ARTIFACT_FD, F_GETFL);
  struct stat held_stat;
  Identity initial_held_identity;
  if (held_flags < 0 || (held_flags & O_ACCMODE) != O_RDONLY ||
      fstat(HELD_ARTIFACT_FD, &held_stat) != 0 ||
      !identity_from_stat(&held_stat, &initial_held_identity) ||
      !S_ISREG(held_stat.st_mode) || initial_held_identity.uid != (uintmax_t)geteuid() ||
      initial_held_identity.uid != record->identity.uid ||
      (initial_held_identity.mode & 0777U) != 0600U ||
      initial_held_identity.mode != record->identity.mode || initial_held_identity.nlink != 1U) {
    return write_error('C', "HELD") && false;
  }

  Identity held_identity;
  char held_digest[72];
  if (!hash_fd_stable(HELD_ARTIFACT_FD, &held_identity, held_digest)) {
    return write_error('C', "HELD") && false;
  }
  if (held_identity.dev != record->identity.dev) return write_error('C', "DEV") && false;
  if (held_identity.ino != record->identity.ino) return write_error('C', "INO") && false;
  if (held_identity.uid != record->identity.uid) return write_error('C', "UID") && false;
  if (held_identity.mode != record->identity.mode) return write_error('C', "MODE") && false;
  if (held_identity.nlink != record->identity.nlink &&
      !(held_identity.nlink == 0U && record->identity.nlink == 1U)) {
    return write_error('C', "NLINK") && false;
  }
  if (held_identity.size != record->identity.size) return write_error('C', "SIZE") && false;
  if (strcmp(held_digest, record->sha256) != 0) return write_error('C', "DIGEST") && false;
  // The held fd plus dev/ino/uid/mode/nlink/size/content digest is the exact
  // cleanup authority. Descriptor inheritance may advance host metadata time;
  // bind the native observation for all later source/quarantine comparisons.
  record->identity.mtime_ns = held_identity.mtime_ns;
  record->identity.ctime_ns = held_identity.ctime_ns;
  if (!revalidate_tree(root)) return write_error('C', "ROOT") && false;

  char control_bytes[MAX_RECORD_BYTES + 1U];
  char proof_bytes[MAX_RECORD_BYTES + 1U];
  char receipt_bytes[MAX_RECORD_BYTES + 1U];
  bool created_control = false;
  (void)created_control;
  int control_probe = openat(root->recovery_fd, record->control, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (control_probe >= 0) {
    (void)close(control_probe);
    if (!load_control(root->recovery_fd, record, control_bytes)) {
      return write_error('C', "UNKNOWN") && false;
    }
  } else {
    if (errno != ENOENT || !random_quarantine(record->quarantine) ||
        !make_control(record, control_bytes)) return write_error('C', "UNKNOWN") && false;
    extract_record_digest(control_bytes, record->control_digest);
    if (!immutable_record(root->recovery_fd, record->control, control_bytes)) {
      return write_error('C', "UNKNOWN") && false;
    }
    created_control = true;
  }
  if (!make_proof(record, proof_bytes)) return write_error('C', "PROTOCOL") && false;
  extract_record_digest(proof_bytes, record->proof_digest);
  if (!make_receipt(record, receipt_bytes)) return write_error('C', "PROTOCOL") && false;
  extract_record_digest(receipt_bytes, record->receipt_digest);

  bool receipt_present = false;
  if (!record_present_exact(root->recovery_fd, record->receipt, receipt_bytes, &receipt_present)) {
    return write_error('C', "UNKNOWN") && false;
  }
  if (receipt_present) {
    struct stat ignored;
    if (fstatat(root->recovery_fd, record->basename, &ignored, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT ||
        fstatat(root->recovery_fd, record->quarantine, &ignored, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT ||
        !revalidate_tree(root)) return write_error('C', "UNKNOWN") && false;
    char response[768];
    int length = snprintf(response, sizeof(response),
      "C\tOK\tCOMMITTED\t%s\t%s\t%s\t%s\t%s\n", record->quarantine,
      record->control, record->proof, record->receipt, record->receipt_digest);
    return length > 0 && (size_t)length < sizeof(response) && write_line(response);
  }
#ifdef WRITCRAFT_TEST_CRASH_OPEN_RENAME
  if (created_control) _exit(81);
#endif

  int source_fd = -1;
  NameState source_state = open_name_exact(
    root->recovery_fd, record->basename, &record->identity, record->sha256, &source_fd
  );
  int quarantine_fd = -1;
  NameState quarantine_state = open_name_exact(
    root->recovery_fd, record->quarantine, &record->identity, record->sha256, &quarantine_fd
  );
  bool moved_now = false;
  (void)moved_now;
  if (source_state == NAME_EXACT && quarantine_state == NAME_ABSENT) {
    if (!path_matches_fd(root->recovery_fd, record->basename, source_fd) || !revalidate_tree(root) ||
        renameatx_np(root->recovery_fd, record->basename, root->recovery_fd,
          record->quarantine, RENAME_EXCL) != 0) {
      (void)close(source_fd);
      return write_error('C', errno == EEXIST ? "UNKNOWN" : "UNCOMMITTED") && false;
    }
    moved_now = true;
  } else if (!(source_state == NAME_ABSENT && quarantine_state == NAME_EXACT)) {
    if (source_fd >= 0) (void)close(source_fd);
    if (quarantine_fd >= 0) (void)close(quarantine_fd);
    if (source_state == NAME_ABSENT && quarantine_state == NAME_ABSENT) {
      bool proof_present = false;
      if (!record_present_exact(root->recovery_fd, record->proof, proof_bytes, &proof_present) ||
          !proof_present || fsync(root->recovery_fd) != 0 || !revalidate_tree(root) ||
          !immutable_record(root->recovery_fd, record->receipt, receipt_bytes)) {
        return write_error('C', "UNKNOWN") && false;
      }
      char response[768];
      int length = snprintf(response, sizeof(response),
        "C\tOK\tCOMMITTED\t%s\t%s\t%s\t%s\t%s\n", record->quarantine,
        record->control, record->proof, record->receipt, record->receipt_digest);
      return length > 0 && (size_t)length < sizeof(response) && write_line(response);
    }
    return write_error('C', "UNKNOWN") && false;
  }
#ifdef WRITCRAFT_TEST_CRASH_RENAME_REOPEN
  if (moved_now) _exit(82);
#endif
#ifdef WRITCRAFT_TEST_LATE_REPLACEMENT
  if (moved_now) {
    int foreign_fd = openat(root->recovery_fd, record->basename,
      O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (foreign_fd >= 0) { (void)fsync(foreign_fd); (void)close(foreign_fd); (void)fsync(root->recovery_fd); }
  }
#endif
  struct stat source_name_stat;
  if (fstatat(root->recovery_fd, record->basename, &source_name_stat, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
    (void)close(source_fd);
    return write_error('C', "UNKNOWN") && false;
  }
  if (quarantine_fd < 0) quarantine_state = open_name_exact(
    root->recovery_fd, record->quarantine, &record->identity, record->sha256, &quarantine_fd
  );
  bool proof_preexisting = false;
  if (!record_present_exact(root->recovery_fd, record->proof, proof_bytes, &proof_preexisting) ||
      quarantine_state != NAME_EXACT || !path_matches_fd(root->recovery_fd, record->quarantine, quarantine_fd) ||
      !same_bound_object(&held_identity, &record->identity) || !revalidate_tree(root) ||
      !immutable_record(root->recovery_fd, record->proof, proof_bytes)) {
    if (quarantine_fd >= 0) (void)close(quarantine_fd);
    (void)close(source_fd);
    return write_error('C', "UNKNOWN") && false;
  }
#ifdef WRITCRAFT_TEST_CRASH_REOPEN_UNLINK
  if (!proof_preexisting) _exit(83);
#endif
  if (!path_matches_fd(root->recovery_fd, record->quarantine, quarantine_fd) ||
      unlinkat(root->recovery_fd, record->quarantine, 0) != 0) {
    (void)close(quarantine_fd);
    (void)close(source_fd);
    return write_error('C', "UNKNOWN") && false;
  }
  (void)close(quarantine_fd);
  (void)close(source_fd);
#ifdef WRITCRAFT_TEST_CRASH_UNLINK_FSYNC
  _exit(84);
#endif
  if (fsync(root->recovery_fd) != 0 || !revalidate_tree(root) ||
      !immutable_record(root->recovery_fd, record->receipt, receipt_bytes)) {
    return write_error('C', "UNKNOWN") && false;
  }
#ifdef WRITCRAFT_TEST_DROP_COMMITTED_RESPONSE
  _exit(85);
#endif
  char response[768];
  int length = snprintf(response, sizeof(response),
    "C\tOK\tCOMMITTED\t%s\t%s\t%s\t%s\t%s\n", record->quarantine,
    record->control, record->proof, record->receipt, record->receipt_digest);
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static bool name_absent(int directory, const char *name) {
  struct stat value;
  return fstatat(directory, name, &value, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
}

static bool reconcile(char *line, RootBinding *root) {
  char *fields[4];
  size_t count = 0U;
  uintmax_t expected_bytes = 0U;
  if (!split_fields(line, fields, 4U, &count) || count != 4U || strcmp(fields[0], "R") != 0 ||
      !valid_artifact_basename(fields[1]) ||
      !parse_uint(fields[2], MAX_ARTIFACT_BYTES, &expected_bytes) || !valid_digest(fields[3]) ||
      !revalidate_tree(root)) return write_error('R', "PROTOCOL") && false;
  int duplicate = fcntl(root->recovery_fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return write_error('R', "UNKNOWN") && false;
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    (void)close(duplicate);
    return write_error('R', "UNKNOWN") && false;
  }
  CleanupRecord found;
  memset(&found, 0, sizeof(found));
  bool matched = false;
  size_t inspected = 0U;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    inspected += 1U;
    if (inspected > 2048U) {
      (void)closedir(directory);
      return write_error('R', "BUDGET") && false;
    }
    if (!valid_generated_name(entry->d_name, ".changes-history-cleanup-control.", 64U)) continue;
    char bytes[MAX_RECORD_BYTES + 1U];
    CleanupRecord candidate;
    memset(&candidate, 0, sizeof(candidate));
    if (!read_record_bytes(root->recovery_fd, entry->d_name, bytes) ||
        !parse_control_any(bytes, &candidate) || strcmp(candidate.control, entry->d_name) != 0) {
      (void)closedir(directory);
      return write_error('R', "UNKNOWN") && false;
    }
    if (strcmp(candidate.basename, fields[1]) != 0 ||
        candidate.byte_length != (uint64_t)expected_bytes || strcmp(candidate.sha256, fields[3]) != 0) continue;
    if (matched) {
      (void)closedir(directory);
      return write_error('R', "UNKNOWN") && false;
    }
    found = candidate;
    matched = true;
  }
  (void)closedir(directory);
  if (!matched) return write_error('R', "UNCOMMITTED") && false;
  char proof_bytes[MAX_RECORD_BYTES + 1U];
  char receipt_bytes[MAX_RECORD_BYTES + 1U];
  if (!make_proof(&found, proof_bytes)) return write_error('R', "UNKNOWN") && false;
  extract_record_digest(proof_bytes, found.proof_digest);
  if (!make_receipt(&found, receipt_bytes)) return write_error('R', "UNKNOWN") && false;
  extract_record_digest(receipt_bytes, found.receipt_digest);
  bool proof_present = false;
  bool receipt_present = false;
  if (!record_present_exact(root->recovery_fd, found.proof, proof_bytes, &proof_present) || !proof_present ||
      !record_present_exact(root->recovery_fd, found.receipt, receipt_bytes, &receipt_present) ||
      !name_absent(root->recovery_fd, found.basename) || !name_absent(root->recovery_fd, found.quarantine) ||
      fsync(root->recovery_fd) != 0 || !revalidate_tree(root) ||
      (!receipt_present && !immutable_record(root->recovery_fd, found.receipt, receipt_bytes)) ||
      !revalidate_tree(root)) {
    return write_error('R', "UNKNOWN") && false;
  }
  char response[768];
  int length = snprintf(response, sizeof(response),
    "R\tOK\tCOMMITTED\t%s\t%s\t%s\t%s\t%s\n", found.quarantine,
    found.control, found.proof, found.receipt, found.receipt_digest);
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static bool unlink_record_if_exact(int directory, const char *name, const char *expected_bytes) {
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT;
  bool present = false;
  bool valid = record_present_exact(directory, name, expected_bytes, &present) && present;
  struct stat path_stat;
  struct stat held_stat;
  Identity path_identity;
  Identity held_identity;
  valid = valid && fstatat(directory, name, &path_stat, AT_SYMLINK_NOFOLLOW) == 0 &&
    fstat(fd, &held_stat) == 0 && identity_from_stat(&path_stat, &path_identity) &&
    identity_from_stat(&held_stat, &held_identity) && same_regular(&path_identity, &held_identity) &&
    unlinkat(directory, name, 0) == 0;
  (void)close(fd);
  return valid;
}

static bool acknowledge(char *line, RootBinding *root) {
  char *fields[7];
  size_t count = 0U;
  if (!split_fields(line, fields, 7U, &count) || count != 7U || strcmp(fields[0], "A") != 0 ||
      !valid_artifact_basename(fields[1]) ||
      !valid_generated_name(fields[2], ".changes-history-cleanup.", 32U) ||
      !valid_generated_name(fields[3], ".changes-history-cleanup-control.", 64U) ||
      !valid_generated_name(fields[4], ".changes-history-cleanup-proof.", 64U) ||
      !valid_generated_name(fields[5], ".changes-history-cleanup-receipt.", 64U) ||
      !valid_digest(fields[6]) || !revalidate_tree(root) ||
      !name_absent(root->recovery_fd, fields[1]) || !name_absent(root->recovery_fd, fields[2])) {
    return write_error('A', "PROTOCOL") && false;
  }
  // The immutable canonical control is the sole ACK authority. Rebuild the
  // exact proof and receipt from it, then require the token and every record
  // name/digest/content relation to close over that same transaction. A
  // self-hashed replacement is never sufficient authority for unlink.
  char control_bytes[MAX_RECORD_BYTES + 1U];
  CleanupRecord expected;
  memset(&expected, 0, sizeof(expected));
  int control_fd = openat(root->recovery_fd, fields[3], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (control_fd < 0) {
    if (errno != ENOENT || !name_absent(root->recovery_fd, fields[4]) ||
        !name_absent(root->recovery_fd, fields[5])) {
      return write_error('A', "UNKNOWN") && false;
    }
    // All authority records absent is the idempotent state after an ACK whose
    // response was lost. There is no path left for this retry to delete.
    if (fsync(root->recovery_fd) != 0 || !revalidate_tree(root)) {
      return write_error('A', "UNKNOWN") && false;
    }
    return write_line("A\tOK\tACKED\n");
  }
  (void)close(control_fd);
  if (!read_record_bytes(root->recovery_fd, fields[3], control_bytes) ||
      !parse_control_any(control_bytes, &expected) ||
      strcmp(expected.basename, fields[1]) != 0 ||
      strcmp(expected.quarantine, fields[2]) != 0 ||
      strcmp(expected.control, fields[3]) != 0 ||
      strcmp(expected.proof, fields[4]) != 0 ||
      strcmp(expected.receipt, fields[5]) != 0) {
    return write_error('A', "UNKNOWN") && false;
  }
  char proof_bytes[MAX_RECORD_BYTES + 1U];
  char receipt_bytes[MAX_RECORD_BYTES + 1U];
  if (!make_proof(&expected, proof_bytes)) return write_error('A', "UNKNOWN") && false;
  extract_record_digest(proof_bytes, expected.proof_digest);
  if (!make_receipt(&expected, receipt_bytes)) return write_error('A', "UNKNOWN") && false;
  extract_record_digest(receipt_bytes, expected.receipt_digest);
  if (strcmp(expected.receipt_digest, fields[6]) != 0) {
    return write_error('A', "UNKNOWN") && false;
  }

  // Delete only exact bytes reconstructed from the canonical control. Receipt
  // may already be absent on an idempotent retry; proof/control reconstruction
  // still validates the transaction relation before any remaining unlink.
  bool receipt_present = false;
  bool proof_present = false;
  if (!record_present_exact(root->recovery_fd, expected.receipt, receipt_bytes, &receipt_present) ||
      (receipt_present &&
        !unlink_record_if_exact(root->recovery_fd, expected.receipt, receipt_bytes)) ||
      !record_present_exact(root->recovery_fd, expected.proof, proof_bytes, &proof_present) ||
      (proof_present && !unlink_record_if_exact(root->recovery_fd, expected.proof, proof_bytes)) ||
      !unlink_record_if_exact(root->recovery_fd, expected.control, control_bytes)) {
    return write_error('A', "UNKNOWN") && false;
  }
  if (fsync(root->recovery_fd) != 0 || !revalidate_tree(root)) return write_error('A', "UNKNOWN") && false;
  return write_line("A\tOK\tACKED\n");
}

static bool random_marker_quarantine(char out[96]) {
  unsigned char random[16];
  char hex[33];
  static const char alphabet[] = "0123456789abcdef";
  arc4random_buf(random, sizeof(random));
  for (size_t index = 0U; index < sizeof(random); index += 1U) {
    hex[index * 2U] = alphabet[random[index] >> 4U];
    hex[(index * 2U) + 1U] = alphabet[random[index] & 0x0fU];
  }
  hex[32] = '\0';
  int length = snprintf(out, 96U, ".changes-history-marker-clear.%s", hex);
  return length > 0 && length < 96;
}

static bool make_marker_control(
  const MarkerClearRecord *record, char out[MAX_RECORD_BYTES + 1U]
) {
  int length = snprintf(out, MAX_RECORD_BYTES + 1U,
    MARKER_CONTROL_SCHEMA "\t%s\t%s\t" MARKER_BASENAME "\t%" PRIu64
    "\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
    record->operation, record->project, record->byte_length, record->marker_digest,
    record->marker_identity_digest, record->finalized_phase_digest,
    record->artifact_cleanup_digest, record->trusted_root_identity_digest,
    record->project_chain_identity_digest, record->recovery_identity_digest,
    record->quarantine, record->request_digest, record->control_digest);
  return length > 0 && length <= (int)MAX_RECORD_BYTES;
}

static bool make_marker_receipt(
  const MarkerClearRecord *record, char out[MAX_RECORD_BYTES + 1U]
) {
  int length = snprintf(out, MAX_RECORD_BYTES + 1U,
    MARKER_RECEIPT_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%s\t1\t1\t%s\n",
    record->operation, record->request_digest, record->control_digest,
    record->marker_digest, record->marker_identity_digest, record->quarantine,
    record->receipt_digest);
  return length > 0 && length <= (int)MAX_RECORD_BYTES;
}

static NameState fixed_record_state(int directory, const char *name, const char *expected) {
  bool present = false;
  if (record_present_exact(directory, name, expected, &present)) {
    return present ? NAME_EXACT : NAME_ABSENT;
  }
  struct stat ignored;
  if (fstatat(directory, name, &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT) {
    return NAME_ABSENT;
  }
  return NAME_FOREIGN;
}

static bool load_marker_control(
  int directory, MarkerClearRecord *record, char out[MAX_RECORD_BYTES + 1U]
) {
  if (!read_record_bytes(directory, record->control, out)) return false;
  char copy[MAX_RECORD_BYTES + 1U];
  memcpy(copy, out, strlen(out) + 1U);
  size_t length = strlen(copy);
  if (length == 0U || copy[length - 1U] != '\n') return false;
  copy[length - 1U] = '\0';
  char *fields[15];
  size_t count = 0U;
  uintmax_t byte_length = 0U;
  if (!split_fields(copy, fields, 15U, &count) || count != 15U ||
      strcmp(fields[0], MARKER_CONTROL_SCHEMA) != 0 ||
      strcmp(fields[1], record->operation) != 0 || strcmp(fields[2], record->project) != 0 ||
      strcmp(fields[3], MARKER_BASENAME) != 0 ||
      !parse_uint(fields[4], MAX_MARKER_BYTES, &byte_length) ||
      byte_length != record->byte_length || strcmp(fields[5], record->marker_digest) != 0 ||
      strcmp(fields[6], record->marker_identity_digest) != 0 ||
      strcmp(fields[7], record->finalized_phase_digest) != 0 ||
      strcmp(fields[8], record->artifact_cleanup_digest) != 0 ||
      strcmp(fields[9], record->trusted_root_identity_digest) != 0 ||
      strcmp(fields[10], record->project_chain_identity_digest) != 0 ||
      strcmp(fields[11], record->recovery_identity_digest) != 0 ||
      !valid_generated_name(fields[12], ".changes-history-marker-clear.", 32U) ||
      strcmp(fields[13], record->request_digest) != 0 || !valid_digest(fields[14])) return false;
  memcpy(record->quarantine, fields[12], strlen(fields[12]) + 1U);
  if (!marker_control_authority(record) || strcmp(fields[14], record->control_digest) != 0) return false;
  char expected[MAX_RECORD_BYTES + 1U];
  return make_marker_control(record, expected) && strcmp(out, expected) == 0;
}

static bool marker_namespace_clean(int directory, const MarkerClearRecord *record) {
  int duplicate = fcntl(directory, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return false;
  DIR *stream = fdopendir(duplicate);
  if (stream == NULL) {
    (void)close(duplicate);
    return false;
  }
  bool clean = true;
  size_t inspected = 0U;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (entry == NULL) {
      if (errno != 0) clean = false;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    inspected += 1U;
    if (inspected > 2048U) { clean = false; break; }
    bool marker_name = valid_generated_name(
        entry->d_name, ".changes-history-marker-clear.", 32U
      ) || valid_generated_name(
        entry->d_name, ".changes-history-marker-clear-control.", 64U
      ) || valid_generated_name(
        entry->d_name, ".changes-history-marker-clear-receipt.", 64U
      );
    if (!marker_name) continue;
    if (strcmp(entry->d_name, record->control) != 0 &&
        strcmp(entry->d_name, record->receipt) != 0 &&
        (record->quarantine[0] == '\0' || strcmp(entry->d_name, record->quarantine) != 0)) {
      clean = false;
      break;
    }
  }
  (void)closedir(stream);
  return clean;
}

static bool marker_identity_exact(const Identity *actual, const MarkerClearRecord *record) {
  return actual->dev == record->identity.dev && actual->ino == record->identity.ino &&
    actual->uid == record->identity.uid && (actual->mode & 07777U) == record->identity.mode &&
    actual->nlink == record->identity.nlink && actual->size == record->identity.size &&
    actual->mtime_ns == record->identity.mtime_ns && actual->ctime_ns == record->identity.ctime_ns &&
    S_ISREG((mode_t)actual->mode);
}

static bool marker_identity_bound(const Identity *actual, const MarkerClearRecord *record) {
  return actual->dev == record->identity.dev && actual->ino == record->identity.ino &&
    actual->uid == record->identity.uid && (actual->mode & 07777U) == record->identity.mode &&
    actual->nlink == record->identity.nlink && actual->size == record->identity.size &&
    S_ISREG((mode_t)actual->mode);
}

static NameState open_marker_exact(
  int directory, const char *name, const MarkerClearRecord *record,
  bool exact_times, int *fd_out
) {
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? NAME_ABSENT : NAME_ERROR;
  Identity identity;
  char digest[72];
  bool valid = hash_fd_stable(fd, &identity, digest) &&
    (exact_times ? marker_identity_exact(&identity, record) : marker_identity_bound(&identity, record)) &&
    strcmp(digest, record->marker_digest) == 0;
  if (!valid) {
    (void)close(fd);
    return NAME_FOREIGN;
  }
  *fd_out = fd;
  return NAME_EXACT;
}

static bool fixed_record_fd_exact(int fd, const char *expected, Identity *identity_out) {
  size_t length = strlen(expected);
  char bytes[MAX_RECORD_BYTES + 1U];
  struct stat before_stat;
  struct stat after_stat;
  Identity before;
  Identity after;
  if (fstat(fd, &before_stat) != 0 || !identity_from_stat(&before_stat, &before)) return false;
  ssize_t count = pread(fd, bytes, MAX_RECORD_BYTES + 1U, 0);
  bool valid = count == (ssize_t)length && memcmp(bytes, expected, length) == 0 &&
    fstat(fd, &after_stat) == 0 && identity_from_stat(&after_stat, &after) &&
    same_regular(&before, &after) && S_ISREG(after_stat.st_mode) &&
    after_stat.st_uid == geteuid() && (after_stat.st_mode & 0777) == 0600 &&
    after_stat.st_nlink == 1;
  if (!valid) return false;
  *identity_out = after;
  return true;
}

static bool open_fixed_record_exact(
  int directory, const char *name, const char *expected, int *fd_out, Identity *identity_out
) {
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  Identity identity;
  if (!fixed_record_fd_exact(fd, expected, &identity)) {
    (void)close(fd);
    return false;
  }
  *fd_out = fd;
  *identity_out = identity;
  return true;
}

static bool create_marker_record(
  int directory, const char *name, const char *bytes, MarkerRecordIdentity *identity_out
) {
  size_t length = strlen(bytes);
  if (length == 0U || length > MAX_RECORD_BYTES) return false;
  int fd = openat(directory, name, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  size_t offset = 0U;
  while (offset < length) {
    ssize_t count = write(fd, bytes + offset, length - offset);
    if (count <= 0) {
      (void)close(fd);
      return false;
    }
    offset += (size_t)count;
  }
  Identity identity;
  bool valid = fsync(fd) == 0 && fsync(directory) == 0 &&
    fixed_record_fd_exact(fd, bytes, &identity) && path_matches_fd(directory, name, fd);
  if (valid) {
    memset(identity_out, 0, sizeof(*identity_out));
    identity_out->identity = identity;
    identity_out->identity.mode &= 07777U;
    prefixed_digest(
      (const unsigned char *)bytes,
      strlen(bytes),
      identity_out->record_sha256
    );
    valid = marker_record_identity_authority(identity_out);
  }
  (void)close(fd);
  return valid;
}

static bool capture_marker_record_identity(
  int directory, const char *name, const char *expected, MarkerRecordIdentity *out
) {
  int fd = -1;
  Identity identity;
  if (!open_fixed_record_exact(directory, name, expected, &fd, &identity) ||
      !path_matches_fd(directory, name, fd)) {
    if (fd >= 0) (void)close(fd);
    return false;
  }
  (void)close(fd);
  memset(out, 0, sizeof(*out));
  out->identity = identity;
  out->identity.mode &= 07777U;
  prefixed_digest((const unsigned char *)expected, strlen(expected), out->record_sha256);
  return marker_record_identity_authority(out);
}

static bool marker_record_identity_exact(
  const Identity *actual, const MarkerRecordIdentity *expected
) {
  return actual->dev == expected->identity.dev && actual->ino == expected->identity.ino &&
    actual->uid == expected->identity.uid &&
    (actual->mode & 07777U) == expected->identity.mode &&
    actual->nlink == expected->identity.nlink && actual->size == expected->identity.size &&
    actual->mtime_ns == expected->identity.mtime_ns &&
    actual->ctime_ns == expected->identity.ctime_ns && S_ISREG((mode_t)actual->mode);
}

static bool marker_record_current_exact(
  int directory, const char *name, const char *expected,
  const MarkerRecordIdentity *expected_identity
) {
  char record_sha256[72];
  prefixed_digest((const unsigned char *)expected, strlen(expected), record_sha256);
  int fd = -1;
  Identity actual;
  bool exact = strcmp(record_sha256, expected_identity->record_sha256) == 0 &&
    open_fixed_record_exact(directory, name, expected, &fd, &actual) &&
    marker_record_identity_exact(&actual, expected_identity) && path_matches_fd(directory, name, fd);
  if (fd >= 0) (void)close(fd);
  return exact;
}

static bool unlink_marker_record_exact(
  int directory, const char *name, const char *expected,
  const MarkerRecordIdentity *expected_identity
) {
  char record_sha256[72];
  prefixed_digest((const unsigned char *)expected, strlen(expected), record_sha256);
  int held_fd = -1;
  Identity held_identity;
  if (strcmp(record_sha256, expected_identity->record_sha256) != 0 ||
      !open_fixed_record_exact(directory, name, expected, &held_fd, &held_identity) ||
      !marker_record_identity_exact(&held_identity, expected_identity) ||
      !path_matches_fd(directory, name, held_fd)) {
    if (held_fd >= 0) (void)close(held_fd);
    return false;
  }
  char quarantine[96];
  struct stat ignored;
  if (!random_quarantine(quarantine) ||
      fstatat(directory, quarantine, &ignored, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT ||
      !path_matches_fd(directory, name, held_fd) ||
      renameatx_np(directory, name, directory, quarantine, RENAME_EXCL) != 0) {
    (void)close(held_fd);
    return false;
  }
  int quarantine_fd = -1;
  Identity quarantine_identity;
  struct stat held_stat;
  Identity held_after_rename;
  bool valid = name_absent(directory, name) &&
    fstat(held_fd, &held_stat) == 0 && identity_from_stat(&held_stat, &held_after_rename) &&
    open_fixed_record_exact(directory, quarantine, expected, &quarantine_fd, &quarantine_identity) &&
    same_regular(&held_after_rename, &quarantine_identity) &&
    path_matches_fd(directory, quarantine, quarantine_fd) &&
    unlinkat(directory, quarantine, 0) == 0;
  if (quarantine_fd >= 0) (void)close(quarantine_fd);
  (void)close(held_fd);
  return valid && fsync(directory) == 0;
}

static bool write_marker_result(
  const MarkerClearRecord *record, const char *command, const char *state
) {
  char line[MAX_RECORD_BYTES];
  int length;
  if (strcmp(state, "COMMITTED") == 0) {
    length = snprintf(line, sizeof(line),
      "M\tOK\t%s\tCOMMITTED\t%s\t%s\t%s\t%s\t%s\t%s\t%s"
      "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX
      "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIdMAX "\t%" PRIdMAX "\t%s\t%s"
      "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX
      "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIdMAX "\t%" PRIdMAX "\t%s\t%s\n",
      command, record->operation, record->request_digest, record->quarantine,
      record->control, record->receipt, record->control_digest, record->receipt_digest,
      record->control_identity.identity.dev, record->control_identity.identity.ino,
      record->control_identity.identity.uid, record->control_identity.identity.mode,
      record->control_identity.identity.nlink, record->control_identity.identity.size,
      record->control_identity.identity.mtime_ns, record->control_identity.identity.ctime_ns,
      record->control_identity.record_sha256, record->control_identity.identity_digest,
      record->receipt_identity.identity.dev, record->receipt_identity.identity.ino,
      record->receipt_identity.identity.uid, record->receipt_identity.identity.mode,
      record->receipt_identity.identity.nlink, record->receipt_identity.identity.size,
      record->receipt_identity.identity.mtime_ns, record->receipt_identity.identity.ctime_ns,
      record->receipt_identity.record_sha256, record->receipt_identity.identity_digest);
  } else {
    const char *error = strcmp(state, "UNKNOWN") == 0 ? "MARKER_CLEAR_UNKNOWN" : "-";
    length = snprintf(line, sizeof(line), "M\tOK\t%s\t%s\t%s\t%s\t%s\n",
      command, state, record->operation, record->request_digest, error);
  }
  return length > 0 && (size_t)length < sizeof(line) && write_line(line);
}

static bool parse_marker_record_identity(
  char **fields, size_t offset, MarkerRecordIdentity *identity
) {
  uintmax_t mtime_ns = 0U;
  uintmax_t ctime_ns = 0U;
  if (!parse_uint(fields[offset], UINTMAX_MAX, &identity->identity.dev) ||
      !parse_uint(fields[offset + 1U], UINTMAX_MAX, &identity->identity.ino) ||
      !parse_uint(fields[offset + 2U], 9007199254740991ULL, &identity->identity.uid) ||
      !parse_uint(fields[offset + 3U], 0xffffU, &identity->identity.mode) ||
      !parse_uint(fields[offset + 4U], 9007199254740991ULL, &identity->identity.nlink) ||
      !parse_uint(fields[offset + 5U], UINTMAX_MAX, &identity->identity.size) ||
      !parse_uint(fields[offset + 6U], INTMAX_MAX, &mtime_ns) ||
      !parse_uint(fields[offset + 7U], INTMAX_MAX, &ctime_ns) ||
      !valid_digest(fields[offset + 8U]) || !valid_digest(fields[offset + 9U]) ||
      identity->identity.uid != (uintmax_t)geteuid() || identity->identity.mode != 0600U ||
      identity->identity.nlink != 1U) return false;
  identity->identity.mtime_ns = (intmax_t)mtime_ns;
  identity->identity.ctime_ns = (intmax_t)ctime_ns;
  memcpy(identity->record_sha256, fields[offset + 8U], 72U);
  memcpy(identity->identity_digest, fields[offset + 9U], 72U);
  return marker_record_identity_authority(identity);
}

static bool parse_marker_command(char *line, MarkerClearRecord *record) {
  char *fields[47];
  size_t count = 0U;
  uintmax_t value = 0U;
  if (!split_fields(line, fields, 47U, &count) ||
      !((count == 22U && (strcmp(fields[1], "CLEAR") == 0 ||
          strcmp(fields[1], "RECONCILE") == 0)) ||
        (count == 47U && strcmp(fields[1], "ACK") == 0)) ||
      strcmp(fields[0], "M") != 0 || !valid_marker_operation(fields[2]) ||
      !decode_marker_project(fields[3], record->project) ||
      strcmp(fields[4], MARKER_BASENAME) != 0 ||
      !parse_uint(fields[5], MAX_MARKER_BYTES, &value) || value == 0U ||
      !valid_digest(fields[6]) || !valid_digest(fields[7]) || !valid_digest(fields[8]) ||
      !valid_digest(fields[9]) || !valid_digest(fields[10]) || !valid_digest(fields[11]) ||
      !valid_digest(fields[12]) || !valid_digest(fields[13])) return false;
  memcpy(record->command, fields[1], strlen(fields[1]) + 1U);
  memcpy(record->operation, fields[2], strlen(fields[2]) + 1U);
  record->byte_length = (uint64_t)value;
  memcpy(record->marker_digest, fields[6], 72U);
  memcpy(record->marker_identity_digest, fields[7], 72U);
  memcpy(record->finalized_phase_digest, fields[8], 72U);
  memcpy(record->artifact_cleanup_digest, fields[9], 72U);
  memcpy(record->request_digest, fields[10], 72U);
  memcpy(record->trusted_root_identity_digest, fields[11], 72U);
  memcpy(record->project_chain_identity_digest, fields[12], 72U);
  memcpy(record->recovery_identity_digest, fields[13], 72U);
  if (!parse_uint(fields[14], UINTMAX_MAX, &record->identity.dev) ||
      !parse_uint(fields[15], UINTMAX_MAX, &record->identity.ino) ||
      !parse_uint(fields[16], UINTMAX_MAX, &record->identity.uid) ||
      !parse_uint(fields[17], 07777U, &record->identity.mode) ||
      !parse_uint(fields[18], UINTMAX_MAX, &record->identity.nlink) ||
      !parse_uint(fields[19], UINTMAX_MAX, &record->identity.size) ||
      !parse_int(fields[20], &record->identity.mtime_ns) ||
      !parse_int(fields[21], &record->identity.ctime_ns) ||
      record->identity.uid != (uintmax_t)geteuid() || record->identity.mode != 0600U ||
      record->identity.nlink != 1U || record->identity.size != record->byte_length ||
      !marker_request_authority(record)) return false;
  if (strcmp(record->command, "ACK") == 0) {
    if (strcmp(fields[22], record->control) != 0 || strcmp(fields[23], record->receipt) != 0 ||
        !valid_generated_name(fields[24], ".changes-history-marker-clear.", 32U) ||
        !valid_digest(fields[25]) || !valid_digest(fields[26])) return false;
    memcpy(record->quarantine, fields[24], strlen(fields[24]) + 1U);
    if (!marker_control_authority(record) || !marker_receipt_authority(record) ||
        strcmp(fields[25], record->control_digest) != 0 ||
        strcmp(fields[26], record->receipt_digest) != 0 ||
        !parse_marker_record_identity(fields, 27U, &record->control_identity) ||
        !parse_marker_record_identity(fields, 37U, &record->receipt_identity)) return false;
    record->has_record_identities = true;
  }
  return true;
}

static bool held_marker_exact(const MarkerClearRecord *record) {
  int flags = fcntl(HELD_ARTIFACT_FD, F_GETFL);
  struct stat stat_value;
  Identity identity;
  char digest[72];
  return flags >= 0 && (flags & O_ACCMODE) == O_RDONLY &&
    fstat(HELD_ARTIFACT_FD, &stat_value) == 0 && S_ISREG(stat_value.st_mode) &&
    stat_value.st_uid == geteuid() && (stat_value.st_mode & 0777) == 0600 &&
    hash_fd_stable(HELD_ARTIFACT_FD, &identity, digest) &&
    marker_identity_exact(&identity, record) && strcmp(digest, record->marker_digest) == 0;
}

static bool marker_committed_result(
  RootBinding *root, MarkerClearRecord *record, const char *command,
  const char *control_bytes, const char *receipt_bytes
) {
  if (!record->has_record_identities) {
    if (!capture_marker_record_identity(
        root->recovery_fd, record->control, control_bytes, &record->control_identity
      ) || !capture_marker_record_identity(
        root->recovery_fd, record->receipt, receipt_bytes, &record->receipt_identity
      )) return write_marker_result(record, command, "UNKNOWN");
    record->has_record_identities = true;
  }
  bool exact = revalidate_tree(root) && marker_root_authority_matches(root, record) &&
    marker_namespace_clean(root->recovery_fd, record) &&
    marker_record_current_exact(
      root->recovery_fd, record->control, control_bytes, &record->control_identity
    ) && marker_record_current_exact(
      root->recovery_fd, record->receipt, receipt_bytes, &record->receipt_identity
    ) &&
    name_absent(root->recovery_fd, MARKER_BASENAME) &&
    name_absent(root->recovery_fd, record->quarantine);
  return write_marker_result(record, command, exact ? "COMMITTED" : "UNKNOWN");
}

static bool marker_clear_exact(RootBinding *root, MarkerClearRecord *record) {
  if (!held_marker_exact(record) || !revalidate_tree(root) ||
      !marker_root_authority_matches(root, record)) {
    return write_marker_result(record, "CLEAR", "UNKNOWN");
  }
  char control_bytes[MAX_RECORD_BYTES + 1U];
  char receipt_bytes[MAX_RECORD_BYTES + 1U];
  NameState control_state = fixed_record_state(root->recovery_fd, record->control, "");
  NameState receipt_prestate = fixed_record_state(root->recovery_fd, record->receipt, "");
  bool created_control = false;
  if (control_state != NAME_ABSENT || receipt_prestate != NAME_ABSENT ||
      !marker_namespace_clean(root->recovery_fd, record) ||
      !random_marker_quarantine(record->quarantine) ||
      !marker_control_authority(record) || !marker_receipt_authority(record) ||
      !make_marker_control(record, control_bytes) || !make_marker_receipt(record, receipt_bytes) ||
      !create_marker_record(
        root->recovery_fd, record->control, control_bytes, &record->control_identity
      )) {
    return write_marker_result(record, "CLEAR", "UNKNOWN");
  }
  created_control = true;
  if (!marker_namespace_clean(root->recovery_fd, record)) {
    return write_marker_result(record, "CLEAR", "UNKNOWN");
  }
  NameState receipt_state = fixed_record_state(root->recovery_fd, record->receipt, receipt_bytes);
  if (receipt_state != NAME_ABSENT) return write_marker_result(record, "CLEAR", "UNKNOWN");
#ifdef WRITCRAFT_TEST_MARKER_CRASH_OPEN_RENAME
  if (created_control) _exit(101);
#else
  (void)created_control;
#endif
  int source_fd = -1;
  int quarantine_fd = -1;
  NameState source_state = open_marker_exact(
    root->recovery_fd, MARKER_BASENAME, record, true, &source_fd
  );
  NameState quarantine_state = open_marker_exact(
    root->recovery_fd, record->quarantine, record, false, &quarantine_fd
  );
  bool moved_now = false;
  if (source_state == NAME_EXACT && quarantine_state == NAME_ABSENT) {
    if (!path_matches_fd(root->recovery_fd, MARKER_BASENAME, source_fd) ||
        !revalidate_tree(root) || renameatx_np(root->recovery_fd, MARKER_BASENAME,
          root->recovery_fd, record->quarantine, RENAME_EXCL) != 0) {
      (void)close(source_fd);
      return write_marker_result(record, "CLEAR", "UNKNOWN");
    }
    moved_now = true;
  } else if (!(source_state == NAME_ABSENT && quarantine_state == NAME_EXACT)) {
    if (source_fd >= 0) (void)close(source_fd);
    if (quarantine_fd >= 0) (void)close(quarantine_fd);
    return write_marker_result(record, "CLEAR", "UNKNOWN");
  }
#ifdef WRITCRAFT_TEST_MARKER_CRASH_RENAME_REOPEN
  if (moved_now) _exit(102);
#else
  (void)moved_now;
#endif
#ifdef WRITCRAFT_TEST_MARKER_LATE_REPLACEMENT
  if (moved_now) {
    int foreign = openat(root->recovery_fd, MARKER_BASENAME,
      O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (foreign >= 0) { (void)fsync(foreign); (void)close(foreign); (void)fsync(root->recovery_fd); }
  }
#endif
  if (!name_absent(root->recovery_fd, MARKER_BASENAME)) {
    if (source_fd >= 0) (void)close(source_fd);
    if (quarantine_fd >= 0) (void)close(quarantine_fd);
    return write_marker_result(record, "CLEAR", "UNKNOWN");
  }
  if (quarantine_fd < 0) quarantine_state = open_marker_exact(
    root->recovery_fd, record->quarantine, record, false, &quarantine_fd
  );
  if (quarantine_state != NAME_EXACT ||
      !path_matches_fd(root->recovery_fd, record->quarantine, quarantine_fd) ||
      !revalidate_tree(root)) {
    if (source_fd >= 0) (void)close(source_fd);
    if (quarantine_fd >= 0) (void)close(quarantine_fd);
    return write_marker_result(record, "CLEAR", "UNKNOWN");
  }
#ifdef WRITCRAFT_TEST_MARKER_CRASH_REOPEN_UNLINK
  _exit(103);
#endif
  if (unlinkat(root->recovery_fd, record->quarantine, 0) != 0) {
    if (source_fd >= 0) (void)close(source_fd);
    (void)close(quarantine_fd);
    return write_marker_result(record, "CLEAR", "UNKNOWN");
  }
  if (source_fd >= 0) (void)close(source_fd);
  (void)close(quarantine_fd);
#ifdef WRITCRAFT_TEST_MARKER_CRASH_UNLINK_FSYNC
  _exit(104);
#endif
  if (fsync(root->recovery_fd) != 0 || !revalidate_tree(root) ||
      !marker_root_authority_matches(root, record) ||
      !name_absent(root->recovery_fd, MARKER_BASENAME) ||
      !name_absent(root->recovery_fd, record->quarantine) ||
      !marker_record_current_exact(
        root->recovery_fd, record->control, control_bytes, &record->control_identity
      ) ||
      !create_marker_record(
        root->recovery_fd, record->receipt, receipt_bytes, &record->receipt_identity
      )) {
    return write_marker_result(record, "CLEAR", "UNKNOWN");
  }
  record->has_record_identities = true;
#ifdef WRITCRAFT_TEST_MARKER_DROP_COMMITTED_RESPONSE
  _exit(105);
#endif
  return marker_committed_result(root, record, "CLEAR", control_bytes, receipt_bytes);
}

static bool marker_reconcile(RootBinding *root, MarkerClearRecord *record) {
  char control_bytes[MAX_RECORD_BYTES + 1U];
  char receipt_bytes[MAX_RECORD_BYTES + 1U];
  if (!revalidate_tree(root) || !marker_root_authority_matches(root, record) ||
      !load_marker_control(root->recovery_fd, record, control_bytes) ||
      !marker_receipt_authority(record) || !make_marker_receipt(record, receipt_bytes) ||
      !marker_namespace_clean(root->recovery_fd, record)) {
    return write_marker_result(record, "RECONCILE", "UNKNOWN");
  }
  NameState receipt_state = fixed_record_state(root->recovery_fd, record->receipt, receipt_bytes);
  if (receipt_state == NAME_EXACT) {
    return marker_committed_result(root, record, "RECONCILE", control_bytes, receipt_bytes);
  }
  int source_fd = -1;
  int quarantine_fd = -1;
  NameState source_state = open_marker_exact(
    root->recovery_fd, MARKER_BASENAME, record, true, &source_fd
  );
  NameState quarantine_state = open_marker_exact(
    root->recovery_fd, record->quarantine, record, false, &quarantine_fd
  );
  if (quarantine_fd >= 0) (void)close(quarantine_fd);
  if (receipt_state != NAME_ABSENT || source_state != NAME_EXACT ||
      quarantine_state != NAME_ABSENT || !path_matches_fd(
        root->recovery_fd, MARKER_BASENAME, source_fd
      ) || !capture_marker_record_identity(
        root->recovery_fd, record->control, control_bytes, &record->control_identity
      ) || !unlink_marker_record_exact(
        root->recovery_fd, record->control, control_bytes, &record->control_identity
      ) ||
      !name_absent(root->recovery_fd, record->control) ||
      !name_absent(root->recovery_fd, record->receipt) ||
      !name_absent(root->recovery_fd, record->quarantine) ||
      !path_matches_fd(root->recovery_fd, MARKER_BASENAME, source_fd) ||
      fsync(root->recovery_fd) != 0 || !revalidate_tree(root) ||
      !marker_root_authority_matches(root, record) ||
      !name_absent(root->recovery_fd, record->control) ||
      !name_absent(root->recovery_fd, record->receipt) ||
      !name_absent(root->recovery_fd, record->quarantine) ||
      !path_matches_fd(root->recovery_fd, MARKER_BASENAME, source_fd)) {
    if (source_fd >= 0) (void)close(source_fd);
    return write_marker_result(record, "RECONCILE", "UNKNOWN");
  }
  (void)close(source_fd);
  return write_marker_result(record, "RECONCILE", "UNCOMMITTED");
}

static bool marker_acknowledge(RootBinding *root, MarkerClearRecord *record) {
  char control_bytes[MAX_RECORD_BYTES + 1U];
  char receipt_bytes[MAX_RECORD_BYTES + 1U];
  if (!make_marker_control(record, control_bytes) || !make_marker_receipt(record, receipt_bytes) ||
      !revalidate_tree(root) || !marker_root_authority_matches(root, record) ||
      !marker_namespace_clean(root->recovery_fd, record) ||
      !name_absent(root->recovery_fd, MARKER_BASENAME) ||
      !name_absent(root->recovery_fd, record->quarantine)) {
    return write_marker_result(record, "ACK", "UNKNOWN");
  }
  NameState control_state = fixed_record_state(root->recovery_fd, record->control, control_bytes);
  NameState receipt_state = fixed_record_state(root->recovery_fd, record->receipt, receipt_bytes);
  if (control_state == NAME_ABSENT && receipt_state == NAME_ABSENT) {
    if (fsync(root->recovery_fd) != 0 || !revalidate_tree(root) ||
        !marker_root_authority_matches(root, record) ||
        !name_absent(root->recovery_fd, record->control) ||
        !name_absent(root->recovery_fd, record->receipt) ||
        !name_absent(root->recovery_fd, MARKER_BASENAME) ||
        !name_absent(root->recovery_fd, record->quarantine)) {
      return write_marker_result(record, "ACK", "UNKNOWN");
    }
    return write_marker_result(record, "ACK", "ACKED");
  }
#ifdef WRITCRAFT_TEST_MARKER_ACK_LATE_RECEIPT
  if (control_state == NAME_EXACT && receipt_state == NAME_EXACT) {
    static bool injected = false;
    if (!injected) {
      injected = true;
      const char held[] = ".changes-history-marker-clear-test-held-receipt";
      if (renameatx_np(root->recovery_fd, record->receipt,
          root->recovery_fd, held, RENAME_EXCL) == 0) {
        int foreign = openat(root->recovery_fd, record->receipt,
          O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (foreign >= 0) {
          static const char bytes[] = "foreign marker receipt\n";
          (void)write(foreign, bytes, sizeof(bytes) - 1U);
          (void)fsync(foreign);
          (void)close(foreign);
          (void)fsync(root->recovery_fd);
        }
      }
    }
  }
#endif
  if (control_state != NAME_EXACT || receipt_state != NAME_EXACT ||
      !marker_record_current_exact(
        root->recovery_fd, record->control, control_bytes, &record->control_identity
      ) || !marker_record_current_exact(
        root->recovery_fd, record->receipt, receipt_bytes, &record->receipt_identity
      ) || !unlink_marker_record_exact(
        root->recovery_fd, record->receipt, receipt_bytes, &record->receipt_identity
      ) || !unlink_marker_record_exact(
        root->recovery_fd, record->control, control_bytes, &record->control_identity
      ) ||
      !name_absent(root->recovery_fd, record->receipt) ||
      !name_absent(root->recovery_fd, record->control) ||
      fsync(root->recovery_fd) != 0 || !revalidate_tree(root) ||
      !marker_root_authority_matches(root, record) ||
      !name_absent(root->recovery_fd, record->receipt) ||
      !name_absent(root->recovery_fd, record->control) ||
      !name_absent(root->recovery_fd, MARKER_BASENAME) ||
      !name_absent(root->recovery_fd, record->quarantine)) {
    return write_marker_result(record, "ACK", "UNKNOWN");
  }
#ifdef WRITCRAFT_TEST_MARKER_DROP_ACK_RESPONSE
  _exit(106);
#endif
  return write_marker_result(record, "ACK", "ACKED");
}

static bool marker_command(char *line, RootBinding *root) {
  MarkerClearRecord record;
  memset(&record, 0, sizeof(record));
  if (!parse_marker_command(line, &record)) return write_error('M', "PROTOCOL") && false;
  if (strcmp(record.command, "CLEAR") == 0) return marker_clear_exact(root, &record);
  if (strcmp(record.command, "RECONCILE") == 0) return marker_reconcile(root, &record);
  return marker_acknowledge(root, &record);
}

static bool journal_id_valid(const char *value) {
  if (value == NULL || strlen(value) != 53U || strncmp(value, "chrj_", 5U) != 0) return false;
  for (size_t index = 5U; index < 53U; index += 1U) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}

static bool journal_head_parse(
  const char *journal_id, const char *generation, const char *value_digest,
  JournalHead *head
) {
  uintmax_t parsed_generation = 0U;
  if (!journal_id_valid(journal_id) || !parse_uint(generation, UINT64_MAX, &parsed_generation) ||
      !valid_digest(value_digest)) return false;
  (void)parsed_generation;
  memcpy(head->journal_id, journal_id, 54U);
  memcpy(head->generation, generation, strlen(generation) + 1U);
  memcpy(head->value_digest, value_digest, 72U);
  return true;
}

static bool journal_same_head(const JournalHead *left, const JournalHead *right) {
  return strcmp(left->journal_id, right->journal_id) == 0 &&
    strcmp(left->generation, right->generation) == 0 &&
    strcmp(left->value_digest, right->value_digest) == 0;
}

static bool journal_next_generation(const JournalHead *previous, const JournalHead *next) {
  uintmax_t previous_value = 0U;
  uintmax_t next_value = 0U;
  return parse_uint(previous->generation, UINT64_MAX, &previous_value) &&
    parse_uint(next->generation, UINT64_MAX, &next_value) && previous_value != UINT64_MAX &&
    next_value == previous_value + 1U;
}

static bool journal_frame_parse(
  const unsigned char *bytes, size_t length, JournalFrame *frame
) {
  if (bytes == NULL || length < 2U || (uint64_t)length > JOURNAL_MAX_FRAME_BYTES) return false;
  size_t newline = 0U;
  while (newline < length && newline < JOURNAL_MAX_HEADER_BYTES && bytes[newline] != '\n') {
    if (bytes[newline] == 0U || bytes[newline] > 0x7fU) return false;
    newline += 1U;
  }
  if (newline == 0U || newline >= length || newline >= JOURNAL_MAX_HEADER_BYTES ||
      bytes[newline] != '\n') return false;
  char header[JOURNAL_MAX_HEADER_BYTES + 1U];
  memcpy(header, bytes, newline);
  header[newline] = '\0';
  char *fields[8];
  size_t count = 0U;
  uintmax_t payload_length = 0U;
  if (!split_fields(header, fields, 8U, &count) || count != 8U ||
      strcmp(fields[0], JOURNAL_MAGIC) != 0 ||
      (strcmp(fields[1], "A") != 0 && strcmp(fields[1], "B") != 0) ||
      !journal_head_parse(fields[2], fields[3], fields[5], &frame->head) ||
      !parse_uint(fields[4], JOURNAL_MAX_VALUE_BYTES, &payload_length) || payload_length == 0U ||
      !valid_digest(fields[7]) ||
      !(strcmp(fields[6], "-") == 0 || valid_digest(fields[6]))) return false;
  size_t header_length = newline + 1U;
  if (payload_length > SIZE_MAX - header_length || length != header_length + payload_length) return false;
  const unsigned char *payload = bytes + header_length;
  if (payload[payload_length - 1U] != '\n' || memchr(payload, 0, (size_t)payload_length) != NULL ||
      !strict_utf8(payload, (size_t)payload_length)) return false;
  char payload_digest[72];
  prefixed_digest(payload, (size_t)payload_length, payload_digest);
  if (strcmp(payload_digest, fields[7]) != 0) return false;
  frame->slot = fields[1][0];
  frame->payload_length = (uint64_t)payload_length;
  frame->header_length = header_length;
  frame->previous_is_null = strcmp(fields[6], "-") == 0;
  if (frame->previous_is_null) frame->previous_value_digest[0] = '\0';
  else memcpy(frame->previous_value_digest, fields[6], 72U);
  memcpy(frame->payload_sha256, fields[7], 72U);
  return true;
}

static bool journal_request_authority(const JournalRequest *request) {
  char canonical[2048];
  size_t offset = 0U;
  int length = snprintf(canonical, sizeof(canonical),
    "{\"command\":\"%s\",\"expectedHeads\":[", request->command);
  if (length <= 0 || (size_t)length >= sizeof(canonical)) return false;
  offset = (size_t)length;
  for (size_t index = 0U; index < request->head_count; index += 1U) {
    const JournalHead *head = &request->heads[index];
    length = snprintf(canonical + offset, sizeof(canonical) - offset,
      "%s{\"generation\":\"%s\",\"journalId\":\"%s\",\"schema\":\"%s\","
      "\"valueDigest\":\"%s\"}", index == 0U ? "" : ",", head->generation,
      head->journal_id, JOURNAL_HEAD_SCHEMA, head->value_digest);
    if (length <= 0 || (size_t)length >= sizeof(canonical) - offset) return false;
    offset += (size_t)length;
  }
  char frame_digest[72];
  if (request->frame_bytes != NULL) {
    prefixed_digest(request->frame_bytes, request->frame_length, frame_digest);
    length = snprintf(canonical + offset, sizeof(canonical) - offset,
      "],\"nextFrameSha256\":\"%s\",\"schema\":\"%s\"}",
      frame_digest, JOURNAL_REQUEST_AUTHORITY_SCHEMA);
  } else {
    length = snprintf(canonical + offset, sizeof(canonical) - offset,
      "],\"nextFrameSha256\":null,\"schema\":\"%s\"}",
      JOURNAL_REQUEST_AUTHORITY_SCHEMA);
  }
  if (length <= 0 || (size_t)length >= sizeof(canonical) - offset) return false;
  char digest[72];
  authority_digest(JOURNAL_REQUEST_AUTHORITY_SCHEMA, canonical, digest);
  return strcmp(digest, request->request_digest) == 0;
}

static bool journal_read_payload(JournalRequest *request, uint64_t declared, const char *digest) {
  if (declared == 0U || declared > JOURNAL_MAX_FRAME_BYTES || declared > SIZE_MAX ||
      !valid_digest(digest)) return false;
  request->frame_bytes = malloc((size_t)declared);
  if (request->frame_bytes == NULL) return false;
  request->frame_length = (size_t)declared;
  size_t offset = 0U;
  while (offset < request->frame_length) {
    size_t count = fread(request->frame_bytes + offset, 1U, request->frame_length - offset, stdin);
    if (count == 0U) return false;
    offset += count;
  }
  if (fgetc(stdin) != EOF || ferror(stdin)) return false;
  char actual[72];
  prefixed_digest(request->frame_bytes, request->frame_length, actual);
  return strcmp(actual, digest) == 0 &&
    journal_frame_parse(request->frame_bytes, request->frame_length, &request->frame);
}

static bool journal_request_parse(char *line, JournalRequest *request) {
  char *fields[11];
  size_t count = 0U;
  uintmax_t declared = 0U;
  if (!split_fields(line, fields, 11U, &count) || count < 3U ||
      strcmp(fields[0], JOURNAL_REQUEST_MAGIC) != 0 ||
      (strcmp(fields[1], "DISCOVER") != 0 && strcmp(fields[1], "INIT") != 0 &&
       strcmp(fields[1], "READ") != 0 &&
       strcmp(fields[1], "APPEND") != 0) || !valid_digest(fields[2])) return false;
  memcpy(request->command, fields[1], strlen(fields[1]) + 1U);
  memcpy(request->request_digest, fields[2], 72U);
  if (strcmp(request->command, "DISCOVER") == 0) {
    return count == 3U && fgetc(stdin) == EOF && !ferror(stdin) &&
      journal_request_authority(request);
  }
  if (strcmp(request->command, "READ") == 0) {
    if ((strcmp(fields[3], "1") != 0 && strcmp(fields[3], "2") != 0)) return false;
    request->head_count = fields[3][0] == '1' ? 1U : 2U;
    if (count != 4U + (request->head_count * 3U)) return false;
    for (size_t index = 0U; index < request->head_count; index += 1U) {
      if (!journal_head_parse(fields[4U + (index * 3U)], fields[5U + (index * 3U)],
          fields[6U + (index * 3U)], &request->heads[index])) return false;
    }
    if (request->head_count == 2U &&
        (strcmp(request->heads[0].journal_id, request->heads[1].journal_id) != 0 ||
         !journal_next_generation(&request->heads[0], &request->heads[1]) ||
         strcmp(request->heads[0].value_digest, request->heads[1].value_digest) == 0)) return false;
    return fgetc(stdin) == EOF && !ferror(stdin) && journal_request_authority(request);
  }
  bool init = strcmp(request->command, "INIT") == 0;
  bool append = strcmp(request->command, "APPEND") == 0;
  if ((!init && !append) || count != (init ? 8U : 11U)) return false;
  request->head_count = init ? 1U : 2U;
  if (!journal_head_parse(fields[3], fields[4], fields[5], &request->heads[0])) return false;
  size_t length_index = 6U;
  if (append) {
    if (!journal_head_parse(fields[6], fields[7], fields[8], &request->heads[1]) ||
        strcmp(request->heads[0].journal_id, request->heads[1].journal_id) != 0 ||
        !journal_next_generation(&request->heads[0], &request->heads[1]) ||
        strcmp(request->heads[0].value_digest, request->heads[1].value_digest) == 0) return false;
    length_index = 9U;
  }
  if (!parse_uint(fields[length_index], JOURNAL_MAX_FRAME_BYTES, &declared) ||
      !journal_read_payload(request, (uint64_t)declared, fields[length_index + 1U])) return false;
  const JournalHead *wanted = &request->heads[request->head_count - 1U];
  uintmax_t generation = 0U;
  if (!journal_same_head(&request->frame.head, wanted) ||
      !parse_uint(wanted->generation, UINT64_MAX, &generation) ||
      request->frame.slot != ((generation & 1U) == 0U ? 'A' : 'B') ||
      (init && (generation != 0U || !request->frame.previous_is_null)) ||
      (append && (request->frame.previous_is_null ||
        strcmp(request->frame.previous_value_digest, request->heads[0].value_digest) != 0))) return false;
  return journal_request_authority(request);
}

static bool journal_private_authority(RootBinding *root) {
  return (root->metadata_identity.mode & 0777U) == 0700U &&
    (root->recovery_identity.mode & 0777U) == 0700U && revalidate_tree(root);
}

static bool journal_fd_identity(int fd, Identity *identity) {
  struct stat stat_value;
  int flags = fcntl(fd, F_GETFL);
  return flags >= 0 && (flags & O_ACCMODE) == O_RDWR &&
    fstat(fd, &stat_value) == 0 && identity_from_stat(&stat_value, identity) &&
    S_ISREG(stat_value.st_mode) && stat_value.st_uid == geteuid() &&
    (stat_value.st_mode & 0777) == 0600 && stat_value.st_nlink == 1 &&
    (uintmax_t)stat_value.st_size <= JOURNAL_MAX_FILE_BYTES;
}

static bool journal_pread_all(int fd, unsigned char *bytes, size_t length, off_t offset) {
  size_t consumed = 0U;
  while (consumed < length) {
    ssize_t count = pread(fd, bytes + consumed, length - consumed, offset + (off_t)consumed);
    if (count <= 0) return false;
    consumed += (size_t)count;
  }
  return true;
}

static bool journal_pwrite_all(int fd, const unsigned char *bytes, size_t length, off_t offset) {
  size_t consumed = 0U;
  while (consumed < length) {
    ssize_t count = pwrite(fd, bytes + consumed, length - consumed, offset + (off_t)consumed);
    if (count <= 0) return false;
    consumed += (size_t)count;
  }
  return true;
}

static int journal_value_fsync(int fd) {
#ifdef WRITCRAFT_TEST_JOURNAL_FAIL_VALUE_FSYNC
  (void)fd;
  errno = EIO;
  return -1;
#else
  return fsync(fd);
#endif
}

#if defined(WRITCRAFT_TEST_JOURNAL_REPLACE_BEFORE_VALUE) || \
    defined(WRITCRAFT_TEST_JOURNAL_REWRITE_BEFORE_VALUE)
static bool journal_test_before_value(RootBinding *root, int fd) {
#ifdef WRITCRAFT_TEST_JOURNAL_REPLACE_BEFORE_VALUE
  static const char held_name[] = ".changes-history-journal-test-held";
  struct stat stat_value;
  if (fstat(fd, &stat_value) != 0 || stat_value.st_size < 1 ||
      renameatx_np(root->recovery_fd, JOURNAL_BASENAME,
        root->recovery_fd, held_name, RENAME_EXCL) != 0) return false;
  int replacement = openat(root->recovery_fd, JOURNAL_BASENAME,
    O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (replacement < 0) return false;
  unsigned char bytes[HASH_CHUNK_BYTES];
  off_t offset = 0;
  bool copied = true;
  while (offset < stat_value.st_size) {
    size_t wanted = (uintmax_t)(stat_value.st_size - offset) > sizeof(bytes)
      ? sizeof(bytes) : (size_t)(stat_value.st_size - offset);
    ssize_t count = pread(fd, bytes, wanted, offset);
    if (count <= 0 || !journal_pwrite_all(replacement, bytes, (size_t)count, offset)) {
      copied = false;
      break;
    }
    offset += count;
  }
  copied = copied && fsync(replacement) == 0 && fsync(root->recovery_fd) == 0;
  (void)close(replacement);
  return copied;
#else
  unsigned char byte;
  (void)root;
  return pread(fd, &byte, 1U, 0) == 1 && pwrite(fd, &byte, 1U, 0) == 1 && fsync(fd) == 0;
#endif
}
#else
static bool journal_test_before_value(RootBinding *root, int fd) {
  (void)root;
  (void)fd;
  return true;
}
#endif

static void journal_slot_free(JournalSlot *slot) {
  free(slot->bytes);
  slot->bytes = NULL;
  slot->length = 0U;
  slot->valid = false;
}

static bool journal_slot_read(int fd, off_t slot_offset, char expected_slot, JournalSlot *slot) {
  unsigned char header[JOURNAL_MAX_HEADER_BYTES];
  ssize_t count = pread(fd, header, sizeof(header), slot_offset);
  if (count <= 0) return false;
  size_t newline = 0U;
  while (newline < (size_t)count && header[newline] != '\n') newline += 1U;
  if (newline == (size_t)count || newline >= JOURNAL_MAX_HEADER_BYTES) return false;
  char copy[JOURNAL_MAX_HEADER_BYTES + 1U];
  memcpy(copy, header, newline);
  copy[newline] = '\0';
  char *fields[8];
  size_t field_count = 0U;
  uintmax_t payload_length = 0U;
  if (!split_fields(copy, fields, 8U, &field_count) || field_count != 8U ||
      !parse_uint(fields[4], JOURNAL_MAX_VALUE_BYTES, &payload_length) || payload_length == 0U ||
      payload_length > SIZE_MAX - (newline + 1U)) return false;
  size_t frame_length = newline + 1U + (size_t)payload_length;
  if ((uint64_t)frame_length > JOURNAL_MAX_FRAME_BYTES) return false;
  slot->bytes = malloc(frame_length);
  if (slot->bytes == NULL) return false;
  slot->length = frame_length;
  if (!journal_pread_all(fd, slot->bytes, frame_length, slot_offset) ||
      !journal_frame_parse(slot->bytes, slot->length, &slot->frame) ||
      slot->frame.slot != expected_slot) {
    journal_slot_free(slot);
    return false;
  }
  slot->valid = true;
  return true;
}

static bool journal_head_allowed(const JournalRequest *request, const JournalHead *head) {
  for (size_t index = 0U; index < request->head_count; index += 1U) {
    if (journal_same_head(&request->heads[index], head)) return true;
  }
  return false;
}

static JournalSlot *journal_select(JournalRequest *request, JournalSlot slots[2]) {
  JournalSlot *selected = NULL;
  if (slots[0].valid && !slots[1].valid) selected = &slots[0];
  else if (!slots[0].valid && slots[1].valid) selected = &slots[1];
  else if (slots[0].valid && slots[1].valid &&
      strcmp(slots[0].frame.head.journal_id, slots[1].frame.head.journal_id) == 0) {
    if (journal_next_generation(&slots[0].frame.head, &slots[1].frame.head) &&
        !slots[1].frame.previous_is_null &&
        strcmp(slots[1].frame.previous_value_digest, slots[0].frame.head.value_digest) == 0) {
      selected = &slots[1];
    } else if (journal_next_generation(&slots[1].frame.head, &slots[0].frame.head) &&
        !slots[0].frame.previous_is_null &&
        strcmp(slots[0].frame.previous_value_digest, slots[1].frame.head.value_digest) == 0) {
      selected = &slots[0];
    }
  }
  return selected != NULL && journal_head_allowed(request, &selected->frame.head) ? selected : NULL;
}

static bool journal_is_legacy(int fd) {
  unsigned char prefix[64];
  ssize_t count = pread(fd, prefix, sizeof(prefix), 0);
  if (count <= 0) return false;
  for (ssize_t index = 0; index < count; index += 1) {
    if (prefix[index] == ' ' || prefix[index] == '\t' || prefix[index] == '\r' || prefix[index] == '\n') continue;
    return prefix[index] == '{';
  }
  return false;
}

static bool journal_open_existing(RootBinding *root, int *fd_out, Identity *identity_out) {
  int fd = openat(root->recovery_fd, JOURNAL_BASENAME, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  Identity identity;
  if (!journal_fd_identity(fd, &identity) ||
      !path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, fd)) {
    (void)close(fd);
    return false;
  }
  *fd_out = fd;
  *identity_out = identity;
  return true;
}

static bool journal_write_result(
  const JournalRequest *request, const char *status, const JournalSlot *slot
) {
  char header[1024];
  int length;
  if (slot == NULL) {
    length = snprintf(header, sizeof(header), "%s\t%s\t%s\t%s\t-\t-\t-\t0\t-\n",
      JOURNAL_RESULT_MAGIC, request->command, status, request->request_digest);
  } else {
    length = snprintf(header, sizeof(header), "%s\t%s\tVALUE\t%s\t%s\t%s\t%s\t%" PRIu64
      "\t%s\n", JOURNAL_RESULT_MAGIC, request->command, request->request_digest,
      slot->frame.head.journal_id, slot->frame.head.generation,
      slot->frame.head.value_digest, slot->frame.payload_length, slot->frame.payload_sha256);
  }
  if (length <= 0 || (size_t)length >= sizeof(header) || fputs(header, stdout) == EOF) return false;
  if (slot != NULL && fwrite(slot->bytes + slot->frame.header_length, 1U,
      (size_t)slot->frame.payload_length, stdout) != (size_t)slot->frame.payload_length) return false;
  return fflush(stdout) == 0;
}

typedef enum {
  JOURNAL_DISCOVERY_UNKNOWN = 0,
  JOURNAL_DISCOVERY_BASE = 1,
  JOURNAL_DISCOVERY_PAIR = 2,
} JournalDiscovery;

static JournalDiscovery journal_discover_slots(
  JournalSlot slots[2], JournalSlot **older, JournalSlot **newer
) {
  *older = NULL;
  *newer = NULL;
  if (slots[0].valid && !slots[1].valid &&
      strcmp(slots[0].frame.head.generation, "0") == 0 &&
      slots[0].frame.previous_is_null) {
    *older = &slots[0];
    return JOURNAL_DISCOVERY_BASE;
  }
  if (!slots[0].valid || !slots[1].valid ||
      strcmp(slots[0].frame.head.journal_id, slots[1].frame.head.journal_id) != 0) {
    return JOURNAL_DISCOVERY_UNKNOWN;
  }
  if (journal_next_generation(&slots[0].frame.head, &slots[1].frame.head) &&
      !slots[1].frame.previous_is_null &&
      strcmp(slots[1].frame.previous_value_digest, slots[0].frame.head.value_digest) == 0) {
    *older = &slots[0];
    *newer = &slots[1];
    return JOURNAL_DISCOVERY_PAIR;
  }
  if (journal_next_generation(&slots[1].frame.head, &slots[0].frame.head) &&
      !slots[0].frame.previous_is_null &&
      strcmp(slots[0].frame.previous_value_digest, slots[1].frame.head.value_digest) == 0) {
    *older = &slots[1];
    *newer = &slots[0];
    return JOURNAL_DISCOVERY_PAIR;
  }
  return JOURNAL_DISCOVERY_UNKNOWN;
}

static bool journal_discover_same_slot(const JournalSlot *left, const JournalSlot *right) {
  return left != NULL && right != NULL && left->valid && right->valid &&
    left->frame.slot == right->frame.slot &&
    journal_same_head(&left->frame.head, &right->frame.head) &&
    left->frame.previous_is_null == right->frame.previous_is_null &&
    (left->frame.previous_is_null || strcmp(left->frame.previous_value_digest,
      right->frame.previous_value_digest) == 0) &&
    left->frame.payload_length == right->frame.payload_length &&
    strcmp(left->frame.payload_sha256, right->frame.payload_sha256) == 0;
}

static bool journal_write_discover_result(
  const JournalRequest *request, const char *status,
  const JournalSlot *older, const JournalSlot *newer
) {
  char header[1024];
  int length;
  if (older == NULL) {
    length = snprintf(header, sizeof(header),
      "%s\tDISCOVER\t%s\t%s\t-\t-\t-\t-\t-\t-\t-\t-\t-\t-\t0\t-\n",
      JOURNAL_RESULT_MAGIC, status, request->request_digest);
  } else {
    const char *older_previous = older->frame.previous_is_null
      ? "-" : older->frame.previous_value_digest;
    if (newer == NULL) {
      length = snprintf(header, sizeof(header),
        "%s\tDISCOVER\t%s\t%s\t%c\t%s\t%s\t%s\t%s"
        "\t-\t-\t-\t-\t-\t%" PRIu64 "\t%s\n",
        JOURNAL_RESULT_MAGIC, status, request->request_digest,
        older->frame.slot, older->frame.head.journal_id, older->frame.head.generation,
        older->frame.head.value_digest, older_previous,
        older->frame.payload_length, older->frame.payload_sha256);
    } else {
      const char *newer_previous = newer->frame.previous_is_null
        ? "-" : newer->frame.previous_value_digest;
      length = snprintf(header, sizeof(header),
        "%s\tDISCOVER\t%s\t%s\t%c\t%s\t%s\t%s\t%s"
        "\t%c\t%s\t%s\t%s\t%s\t%" PRIu64 "\t%s\n",
        JOURNAL_RESULT_MAGIC, status, request->request_digest,
        older->frame.slot, older->frame.head.journal_id, older->frame.head.generation,
        older->frame.head.value_digest, older_previous,
        newer->frame.slot, newer->frame.head.journal_id, newer->frame.head.generation,
        newer->frame.head.value_digest, newer_previous,
        older->frame.payload_length, older->frame.payload_sha256);
    }
  }
  if (length <= 0 || (size_t)length >= sizeof(header) || fputs(header, stdout) == EOF) return false;
  if (older != NULL && fwrite(older->bytes + older->frame.header_length, 1U,
      (size_t)older->frame.payload_length, stdout) != (size_t)older->frame.payload_length) return false;
  return fflush(stdout) == 0;
}

static bool journal_read_discovery(
  RootBinding *root, int fd, JournalSlot slots[2], JournalDiscovery *discovery,
  JournalSlot **older, JournalSlot **newer
) {
  if (!journal_private_authority(root) || !path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, fd)) {
    return false;
  }
  (void)journal_slot_read(fd, 0, 'A', &slots[0]);
  (void)journal_slot_read(fd, (off_t)JOURNAL_SLOT_CAPACITY, 'B', &slots[1]);
  *discovery = journal_discover_slots(slots, older, newer);
  return *discovery != JOURNAL_DISCOVERY_UNKNOWN;
}

static bool journal_write_discovery_durable(
  RootBinding *root, JournalRequest *request, int held_fd,
  JournalDiscovery expected_discovery, JournalSlot *expected_older, JournalSlot *expected_newer
) {
  if (journal_value_fsync(held_fd) != 0 || fsync(root->recovery_fd) != 0 ||
      !journal_private_authority(root) ||
      !path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, held_fd)) {
    return journal_write_discover_result(request, "UNKNOWN", NULL, NULL);
  }
  int reopened = -1;
  Identity opened_identity;
  JournalSlot slots[2] = { 0 };
  JournalSlot *older = NULL;
  JournalSlot *newer = NULL;
  JournalDiscovery discovery = JOURNAL_DISCOVERY_UNKNOWN;
  bool valid = journal_open_existing(root, &reopened, &opened_identity) &&
    journal_read_discovery(root, reopened, slots, &discovery, &older, &newer) &&
    discovery == expected_discovery && journal_discover_same_slot(expected_older, older) &&
    ((expected_newer == NULL && newer == NULL) || journal_discover_same_slot(expected_newer, newer)) &&
    journal_test_before_value(root, reopened);
  Identity final_identity;
  valid = valid && journal_fd_identity(reopened, &final_identity) &&
    same_regular(&opened_identity, &final_identity) && journal_private_authority(root) &&
    path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, reopened);
  bool result = valid
    ? journal_write_discover_result(request,
      discovery == JOURNAL_DISCOVERY_BASE ? "BASE" : "PAIR", older, newer)
    : journal_write_discover_result(request, "UNKNOWN", NULL, NULL);
  journal_slot_free(&slots[0]);
  journal_slot_free(&slots[1]);
  if (reopened >= 0) (void)close(reopened);
  return result;
}

static bool journal_discover_legacy_durable(
  RootBinding *root, JournalRequest *request, int held_fd, const Identity *held_identity
) {
  if (journal_value_fsync(held_fd) != 0 || fsync(root->recovery_fd) != 0 ||
      !journal_private_authority(root) ||
      !path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, held_fd)) {
    return journal_write_discover_result(request, "UNKNOWN", NULL, NULL);
  }
  int reopened = -1;
  Identity opened_identity;
  bool valid = journal_open_existing(root, &reopened, &opened_identity) &&
    same_regular(held_identity, &opened_identity) && journal_is_legacy(reopened) &&
    journal_test_before_value(root, reopened);
  Identity final_identity;
  valid = valid && journal_fd_identity(reopened, &final_identity) &&
    same_regular(&opened_identity, &final_identity) && journal_private_authority(root) &&
    path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, reopened) && journal_is_legacy(reopened);
  if (reopened >= 0) (void)close(reopened);
  return journal_write_discover_result(request, valid ? "LEGACY" : "UNKNOWN", NULL, NULL);
}

static bool journal_discover(RootBinding *root, JournalRequest *request) {
  if (!journal_private_authority(root)) {
    return journal_write_discover_result(request, "UNKNOWN", NULL, NULL);
  }
  int fd = openat(root->recovery_fd, JOURNAL_BASENAME, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    if (errno != ENOENT) return journal_write_discover_result(request, "UNKNOWN", NULL, NULL);
    struct stat absent;
    errno = 0;
    bool exact_absence = fstatat(root->recovery_fd, JOURNAL_BASENAME, &absent,
      AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT && fsync(root->recovery_fd) == 0 &&
      journal_private_authority(root);
    errno = 0;
    exact_absence = exact_absence && fstatat(root->recovery_fd, JOURNAL_BASENAME, &absent,
      AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
    return journal_write_discover_result(
      request, exact_absence ? "ABSENT" : "UNKNOWN", NULL, NULL
    );
  }
  Identity held_identity;
  if (!journal_fd_identity(fd, &held_identity) ||
      !path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, fd)) {
    (void)close(fd);
    return journal_write_discover_result(request, "UNKNOWN", NULL, NULL);
  }
  if (journal_is_legacy(fd)) {
    bool result = journal_discover_legacy_durable(root, request, fd, &held_identity);
    (void)close(fd);
    return result;
  }
  JournalSlot slots[2] = { 0 };
  JournalSlot *older = NULL;
  JournalSlot *newer = NULL;
  JournalDiscovery discovery = JOURNAL_DISCOVERY_UNKNOWN;
  bool classified = journal_read_discovery(root, fd, slots, &discovery, &older, &newer);
  bool result = classified
    ? journal_write_discovery_durable(root, request, fd, discovery, older, newer)
    : journal_write_discover_result(request, "UNKNOWN", NULL, NULL);
  journal_slot_free(&slots[0]);
  journal_slot_free(&slots[1]);
  (void)close(fd);
  return result;
}

static bool journal_read_current(
  RootBinding *root, JournalRequest *request, int fd, JournalSlot slots[2], JournalSlot **selected
) {
  if (!journal_private_authority(root) || !path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, fd)) {
    return false;
  }
  (void)journal_slot_read(fd, 0, 'A', &slots[0]);
  (void)journal_slot_read(fd, (off_t)JOURNAL_SLOT_CAPACITY, 'B', &slots[1]);
  *selected = journal_select(request, slots);
  return *selected != NULL;
}

static bool journal_write_value_durable(
  RootBinding *root, JournalRequest *request, int held_fd, const JournalHead *expected
) {
  if (journal_value_fsync(held_fd) != 0 || fsync(root->recovery_fd) != 0 ||
      !journal_private_authority(root) ||
      !path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, held_fd)) {
    return journal_write_result(request, "UNKNOWN", NULL);
  }
  int reopened = -1;
  Identity opened_identity;
  JournalSlot slots[2] = { 0 };
  JournalSlot *selected = NULL;
  bool valid = journal_open_existing(root, &reopened, &opened_identity) &&
    journal_read_current(root, request, reopened, slots, &selected) &&
    journal_same_head(&selected->frame.head, expected) &&
    journal_test_before_value(root, reopened);
  Identity final_identity;
  valid = valid && journal_fd_identity(reopened, &final_identity) &&
    same_regular(&opened_identity, &final_identity) && journal_private_authority(root) &&
    path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, reopened) &&
    journal_same_head(&selected->frame.head, expected);
  bool result = journal_write_result(request, valid ? "VALUE" : "UNKNOWN", valid ? selected : NULL);
  journal_slot_free(&slots[0]);
  journal_slot_free(&slots[1]);
  if (reopened >= 0) (void)close(reopened);
  return result;
}

static bool journal_init(RootBinding *root, JournalRequest *request) {
  if (!journal_private_authority(root)) return journal_write_result(request, "UNKNOWN", NULL);
  int fd = openat(root->recovery_fd, JOURNAL_BASENAME,
    O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) {
    int existing = -1;
    Identity identity;
    if (errno != EEXIST || !journal_open_existing(root, &existing, &identity)) {
      return journal_write_result(request, "UNKNOWN", NULL);
    }
    if (journal_is_legacy(existing)) {
      (void)close(existing);
      return journal_write_result(request, "LEGACY", NULL);
    }
    JournalSlot slots[2] = { 0 };
    JournalSlot *selected = NULL;
    bool valid = journal_read_current(root, request, existing, slots, &selected);
    bool result = valid
      ? journal_write_value_durable(root, request, existing, &selected->frame.head)
      : journal_write_result(request, "UNKNOWN", NULL);
    journal_slot_free(&slots[0]);
    journal_slot_free(&slots[1]);
    (void)close(existing);
    return result;
  }
  Identity created;
  bool written = journal_fd_identity(fd, &created) &&
    journal_pwrite_all(fd, request->frame_bytes, request->frame_length, 0) && fsync(fd) == 0 &&
    fsync(root->recovery_fd) == 0 && journal_private_authority(root) &&
    path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, fd);
  bool result = written
    ? journal_write_value_durable(root, request, fd, &request->heads[0])
    : journal_write_result(request, "UNKNOWN", NULL);
  (void)close(fd);
  return result;
}

static bool journal_read(RootBinding *root, JournalRequest *request) {
  int fd = -1;
  Identity identity;
  if (!journal_open_existing(root, &fd, &identity)) return journal_write_result(request, "UNKNOWN", NULL);
  if (journal_is_legacy(fd)) {
    (void)close(fd);
    return journal_write_result(request, "LEGACY", NULL);
  }
  JournalSlot slots[2] = { 0 };
  JournalSlot *selected = NULL;
  bool valid = journal_read_current(root, request, fd, slots, &selected);
  bool result = valid
    ? journal_write_value_durable(root, request, fd, &selected->frame.head)
    : journal_write_result(request, "UNKNOWN", NULL);
  journal_slot_free(&slots[0]);
  journal_slot_free(&slots[1]);
  (void)close(fd);
  return result;
}

static bool journal_append(RootBinding *root, JournalRequest *request) {
  int fd = -1;
  Identity identity;
  if (!journal_open_existing(root, &fd, &identity) || journal_is_legacy(fd)) {
    if (fd >= 0) (void)close(fd);
    return journal_write_result(request, "UNKNOWN", NULL);
  }
  JournalSlot slots[2] = { 0 };
  JournalSlot *selected = NULL;
  if (!journal_read_current(root, request, fd, slots, &selected)) {
    journal_slot_free(&slots[0]);
    journal_slot_free(&slots[1]);
    (void)close(fd);
    return journal_write_result(request, "UNKNOWN", NULL);
  }
  if (journal_same_head(&selected->frame.head, &request->heads[1])) {
    bool result = journal_write_value_durable(root, request, fd, &request->heads[1]);
    journal_slot_free(&slots[0]);
    journal_slot_free(&slots[1]);
    (void)close(fd);
    return result;
  }
  if (!journal_same_head(&selected->frame.head, &request->heads[0])) {
    journal_slot_free(&slots[0]);
    journal_slot_free(&slots[1]);
    (void)close(fd);
    return journal_write_result(request, "UNKNOWN", NULL);
  }
  off_t slot_offset = request->frame.slot == 'A' ? 0 : (off_t)JOURNAL_SLOT_CAPACITY;
  bool written = journal_private_authority(root) &&
    path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, fd) &&
    journal_pwrite_all(fd, request->frame_bytes + request->frame.header_length,
      (size_t)request->frame.payload_length, slot_offset + (off_t)request->frame.header_length) &&
    fsync(fd) == 0 && journal_private_authority(root) &&
    path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, fd) &&
    journal_pwrite_all(fd, request->frame_bytes, request->frame.header_length, slot_offset) &&
    fsync(fd) == 0 && fsync(root->recovery_fd) == 0 && journal_private_authority(root) &&
    path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, fd);
  journal_slot_free(&slots[0]);
  journal_slot_free(&slots[1]);
  bool result = written
    ? journal_write_value_durable(root, request, fd, &request->heads[1])
    : journal_write_result(request, "UNKNOWN", NULL);
  (void)close(fd);
  return result;
}

static bool journal_command(char *line, RootBinding *root) {
  JournalRequest *request = calloc(1U, sizeof(*request));
  if (request == NULL) return false;
  bool parsed = journal_request_parse(line, request);
  bool result = false;
  if (!parsed) {
    result = false;
  } else if (strcmp(request->command, "DISCOVER") == 0) {
    result = journal_discover(root, request);
  } else if (strcmp(request->command, "INIT") == 0) {
    result = journal_init(root, request);
  } else if (strcmp(request->command, "READ") == 0) {
    result = journal_read(root, request);
  } else {
    result = journal_append(root, request);
  }
  free(request->frame_bytes);
  free(request);
  return result;
}

int main(void) {
  RootBinding root;
  memset(&root, 0, sizeof(root));
  root.project_fd = -1;
  root.recovery_fd = -1;
  char line[MAX_LINE_BYTES];
  if (fgets(line, sizeof(line), stdin) == NULL) return 2;
  size_t length = strlen(line);
  if (length == 0U || line[length - 1U] != '\n' || (length > 1U && line[length - 2U] == '\r')) return 2;
  line[length - 1U] = '\0';
  if (!bind_project(line, &root)) return 3;
  if (fgets(line, sizeof(line), stdin) == NULL) return 4;
  length = strlen(line);
  if (length == 0U || line[length - 1U] != '\n' || (length > 1U && line[length - 2U] == '\r')) return 4;
  line[length - 1U] = '\0';
  bool success = false;
  if (line[0] == 'C' && line[1] == '\t') {
    CleanupRecord record;
    memset(&record, 0, sizeof(record));
    success = parse_cleanup(line, &record) && cleanup_exact(&root, &record);
    if (!success && record.basename[0] == '\0') (void)write_error('C', "PROTOCOL");
  } else if (line[0] == 'A' && line[1] == '\t') {
    success = acknowledge(line, &root);
  } else if (line[0] == 'R' && line[1] == '\t') {
    success = reconcile(line, &root);
  } else if (line[0] == 'M' && line[1] == '\t') {
    success = marker_command(line, &root);
  } else if (strncmp(line, JOURNAL_REQUEST_MAGIC "\t", sizeof(JOURNAL_REQUEST_MAGIC)) == 0) {
    success = journal_command(line, &root);
  } else {
    (void)write_error('Q', "PROTOCOL");
  }
  if (root.recovery_fd >= 0) (void)close(root.recovery_fd);
  return success ? 0 : 5;
}
