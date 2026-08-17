#define _DARWIN_C_SOURCE

// WritCraft private missing-leaf CREATE / RECONCILE / FINALIZE_CREATE helper.
// fd 3 is a trusted filesystem-root directory. fd 4 is the held immutable
// recovery artifact for CREATE only. Absolute project paths occur only in the
// initial P bind as UTF-8 hex; later lines contain relative paths as hex and
// bounded digest authority, never Markdown bodies or output paths.

#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define TRUSTED_ROOT_FD 3
#define HELD_ARTIFACT_FD 4
#define HELD_MARKER_FD 5
#define HELD_HISTORY_PARENT_FD 6
#define HELD_HISTORY_FD 7
#define MAX_ITEMS 300U
#define MAX_PATH_BYTES 4096U
#define MAX_SELECTED_BYTES 256U
#define MAX_ROOT_COMPONENTS 128U
#define MAX_LINE_BYTES 16384U
#define MAX_INPUT_BYTES (4U * 1024U * 1024U)
#define MAX_OUTPUT_BYTES (256U * 1024U)
#define MAX_EXISTING_OUTPUT_BYTES (768U * 1024U)
#define MAX_ROLLBACK_OUTPUT_BYTES (512U * 1024U)
#define MAX_CREATE_JOURNAL_OUTPUT_BYTES (1024U * 1024U)
#define MAX_CREATE_JOURNAL_ARTIFACT_BYTES (64ULL * 1024ULL * 1024ULL)
#define MAX_RECORD_BYTES 16384U
#define MAX_RECOVERY_ENTRIES 2048U
#define MAX_ARTIFACT_BYTES (384ULL * 1024ULL * 1024ULL)
#define HASH_CHUNK_BYTES (64U * 1024U)
#define DIGEST_BYTES 71U

#define ROOT_SCHEMA "writcraft.root-identity/v1"
#define ANCESTOR_SCHEMA "writcraft.ancestor-identity/v1"
#define OBJECT_SCHEMA "writcraft.object-identity/v1"
#define CREATED_SCHEMA "writcraft.restore-created-identity/v1"
#define CONTROL_SCHEMA "writcraft.changes-history-native-create-control/v1"
#define RECEIPT_SCHEMA "writcraft.changes-history-native-create-receipt/v1"
#define RECORD_KEY_SCHEMA "writcraft.changes-history-native-create-record-key/v1"
#define RECEIPT_SET_SCHEMA "writcraft.changes-history-native-create-receipt-set/v1"
#define FINAL_KEY_SCHEMA "writcraft.changes-history-native-create-final-key/v1"
#define FINAL_ACK_SCHEMA "writcraft.changes-history-native-create-final-ack/v1"
#define UNDO_CONTROL_SCHEMA "writcraft.changes-history-native-undo-control/v1"
#define UNDO_RECEIPT_SCHEMA "writcraft.changes-history-native-undo-receipt/v1"
#define UNDO_RECORD_KEY_SCHEMA "writcraft.changes-history-native-undo-record-key/v1"
#define UNDO_RECEIPT_SET_SCHEMA "writcraft.changes-history-native-undo-receipt-set/v1"
#define UNDO_FINAL_KEY_SCHEMA "writcraft.changes-history-native-undo-final-key/v1"
#define UNDO_FINAL_SCHEMA "writcraft.changes-history-native-undo-final-record/v1"
#define EXISTING_REQUEST_SCHEMA "writcraft.changes-history-native-existing-restore-request/v1"
#define EXISTING_CONTROL_SCHEMA "writcraft.changes-history-native-existing-restore-control/v1"
#define EXISTING_APPLY_SCHEMA "writcraft.changes-history-native-existing-apply-receipt/v1"
#define EXISTING_ROLLBACK_SCHEMA "writcraft.changes-history-native-existing-rollback-receipt/v1"
#define EXISTING_TERMINAL_SCHEMA "writcraft.changes-history-native-existing-terminal-receipt/v1"
#define EXISTING_RECORD_KEY_SCHEMA "writcraft.changes-history-native-existing-record-key/v1"
#define EXISTING_APPLY_TOKEN_SCHEMA "writcraft.changes-history-native-existing-apply-token/v1"
#define EXISTING_ROLLBACK_TOKEN_SCHEMA "writcraft.changes-history-native-existing-rollback-token/v1"
#define EXISTING_LEAF_SCHEMA "writcraft.public-markdown-existing-leaf-identity/v1"
#define ROLLBACK_REQUEST_SCHEMA "writcraft.changes-history-native-rollback-create-request/v1"
#define ROLLBACK_CONTROL_SCHEMA "writcraft.changes-history-native-rollback-create-control/v1"
#define ROLLBACK_RECEIPT_SCHEMA "writcraft.changes-history-native-rollback-create-receipt/v1"
#define ROLLBACK_RECORD_KEY_SCHEMA "writcraft.changes-history-native-rollback-create-record-key/v1"
#define ROLLBACK_RECEIPT_SET_SCHEMA "writcraft.changes-history-native-rollback-create-receipt-set/v1"
#define ROLLBACK_FINAL_KEY_SCHEMA "writcraft.changes-history-native-rollback-create-final-key/v1"
#define ROLLBACK_FINAL_SCHEMA "writcraft.changes-history-native-rollback-create-final-record/v1"
#define PHASE_SCHEMA "writcraft.changes-history-public-markdown-phase/v1"
#define PHASE_SELECTION_SCHEMA "writcraft.changes-history-public-markdown-selection/v1"
#define CREATE_REQUEST_SCHEMA "writcraft.changes-history-native-create-request/v1"
#define CREATE_ATTEMPT_SCHEMA "writcraft.public-markdown-create-attempt/v1"
#define CREATE_JOURNAL_RESPONSE_SCHEMA "writcraft.public-markdown-create-journal-response/v1"
#define ACTIVE_MARKER_SCHEMA "writcraft.changes-history-active-marker/v1"
#define JOURNAL_HEAD_SCHEMA "writcraft.changes-history-marker-journal-head/v1"
#define CREATE_JOURNAL_PHYSICAL_BINDING_SCHEMA \
  "writcraft.public-markdown-create-journal-physical-binding/v1"
#define CREATE_SLICES_SCHEMA "writcraft.public-markdown-create-current-payload-slices/v1"
#define CREATE_SLICE_SCHEMA "writcraft.public-markdown-create-current-payload-slice/v1"
#define CREATE_COMMAND_SCHEMA "writcraft.public-markdown-create-journal-command-token/v1"
#define PUBLICATION_SCHEMA "writcraft.changes-history-native-publication-authority/v1"
#define MUTATION_SCHEMA "writcraft.changes-history-native-publication-mutation/v1"
#define JOURNAL_MAGIC "WRCCHRJ2"
#define JOURNAL_BASENAME "changes-history-transaction.json"
#define JOURNAL_MAX_VALUE_BYTES (96ULL * 1024ULL * 1024ULL)
#define JOURNAL_MAX_HEADER_BYTES 512U
#define JOURNAL_SLOT_CAPACITY (JOURNAL_MAX_VALUE_BYTES + JOURNAL_MAX_HEADER_BYTES + 1ULL)

#ifdef WRITCRAFT_TEST_DEBUG
#define DEBUG_STAGE(value) do { (void)fprintf(stderr, "debug:%s\n", value); } while (0)
#else
#define DEBUG_STAGE(value) do { } while (0)
#endif

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
  char name[MAX_PATH_BYTES + 1U];
  Identity identity;
  int fd;
} Ancestor;

typedef struct {
  char canonical[MAX_PATH_BYTES + 1U];
  char *components[MAX_ROOT_COMPONENTS];
  size_t component_count;
  Identity component_identities[MAX_ROOT_COMPONENTS];
  char expected_root[DIGEST_BYTES + 1U];
  char expected_recovery[DIGEST_BYTES + 1U];
  int project_fd;
  int recovery_fd;
} RootBinding;

typedef struct {
  char selected[MAX_SELECTED_BYTES + 1U];
  char path[MAX_PATH_BYTES + 1U];
  uint64_t offset;
  uint64_t length;
  char content[DIGEST_BYTES + 1U];
  char ancestor[DIGEST_BYTES + 1U];
  char control_digest[DIGEST_BYTES + 1U];
  char created_digest[DIGEST_BYTES + 1U];
  char receipt_digest[DIGEST_BYTES + 1U];
  char control_name[128];
  char receipt_name[128];
  Identity created_identity;
  Identity control_identity;
  Identity receipt_identity;
  bool created_identity_bound;
  bool control_identity_bound;
  bool receipt_identity_bound;
} Item;

typedef struct {
  char command;
  char operation[64];
  char artifact[DIGEST_BYTES + 1U];
  char artifact_identity[DIGEST_BYTES + 1U];
  uint64_t artifact_length;
  char phase[DIGEST_BYTES + 1U];
  char selection[DIGEST_BYTES + 1U];
  size_t count;
  Item items[MAX_ITEMS];
} Request;

typedef struct {
  uint64_t offset;
  uint64_t length;
  char digest[DIGEST_BYTES + 1U];
} CreateJournalSlice;

typedef struct {
  Request create;
  char command_digest[DIGEST_BYTES + 1U];
  char request_digest[DIGEST_BYTES + 1U];
  char publication_digest[DIGEST_BYTES + 1U];
  char binding_digest[DIGEST_BYTES + 1U];
  char project[MAX_PATH_BYTES + 1U];
  char slot;
  char journal_id[64];
  char generation[32];
  char value_digest[DIGEST_BYTES + 1U];
  uint64_t frame_length;
  char frame_digest[DIGEST_BYTES + 1U];
  uint64_t payload_length;
  char payload_digest[DIGEST_BYTES + 1U];
  uint64_t marker_offset;
  uint64_t marker_length;
  char marker_digest[DIGEST_BYTES + 1U];
  CreateJournalSlice slices[5];
} CreateJournalRequest;

typedef struct {
  CreateJournalRequest *request;
  Identity artifact_identity;
  Identity journal_identity;
} CreateJournalGuard;

typedef struct {
  bool created;
  bool identity_bound;
  int fd;
  size_t bytes_written;
  Identity identity;
} RecordAttempt;

typedef struct {
  bool created;
  bool identity_bound;
  int fd;
  uint64_t bytes_written;
  Identity identity;
} ExistingStageAttempt;

typedef struct {
  Identity identity;
  char content[DIGEST_BYTES + 1U];
} RecordIdentity;

typedef struct {
  size_t ordinal;
  char selected[MAX_SELECTED_BYTES + 1U];
  char role[8];
  char source_name[128];
  char cleanup_name[128];
  char record_digest[DIGEST_BYTES + 1U];
  char item_digest[DIGEST_BYTES + 1U];
  RecordIdentity record;
} CreateCleanupItem;

typedef struct {
  char command;
  char operation[64];
  char create_request[DIGEST_BYTES + 1U];
  char committed_publication[DIGEST_BYTES + 1U];
  char finalize_request[DIGEST_BYTES + 1U];
  char final_ack[DIGEST_BYTES + 1U];
  char final_name[128];
  RecordIdentity final_record;
  char authority_digest[DIGEST_BYTES + 1U];
  size_t count;
  CreateCleanupItem items[MAX_ITEMS * 2U];
} CreateCleanupRequest;

typedef struct {
  size_t parent_index;
  char selected[MAX_SELECTED_BYTES + 1U];
  char path[MAX_PATH_BYTES + 1U];
  uint64_t length;
  char content[DIGEST_BYTES + 1U];
  char ancestor[DIGEST_BYTES + 1U];
  char created[DIGEST_BYTES + 1U];
  char control_digest[DIGEST_BYTES + 1U];
  char quarantine_digest[DIGEST_BYTES + 1U];
  char receipt_digest[DIGEST_BYTES + 1U];
  char control_name[128];
  char receipt_name[128];
  char quarantine_name[128];
  RecordIdentity control_record;
  RecordIdentity receipt_record;
} UndoItem;

typedef struct {
  char command;
  char operation[64];
  char artifact[DIGEST_BYTES + 1U];
  char artifact_identity[DIGEST_BYTES + 1U];
  uint64_t artifact_length;
  char root_digest[DIGEST_BYTES + 1U];
  char recovery_digest[DIGEST_BYTES + 1U];
  char phase[DIGEST_BYTES + 1U];
  char selection[DIGEST_BYTES + 1U];
  char prepared_history[DIGEST_BYTES + 1U];
  char history_phase[DIGEST_BYTES + 1U];
  char receipt_set[DIGEST_BYTES + 1U];
  char final_name[128];
  char final_digest[DIGEST_BYTES + 1U];
  RecordIdentity final_record;
  size_t count;
  UndoItem items[MAX_ITEMS];
} UndoRequest;

typedef struct {
  size_t parent_index;
  char selected[MAX_SELECTED_BYTES + 1U];
  char path[MAX_PATH_BYTES + 1U];
  char before_revision[65];
  char after_revision[65];
  uint64_t before_offset;
  uint64_t before_length;
  char before_content[DIGEST_BYTES + 1U];
  uint64_t after_offset;
  uint64_t after_length;
  char after_content[DIGEST_BYTES + 1U];
  char ancestor[DIGEST_BYTES + 1U];
  char before_leaf[DIGEST_BYTES + 1U];
  char final_content[DIGEST_BYTES + 1U];
  char final_leaf[DIGEST_BYTES + 1U];
  char control_name[128];
  char rollback_name[128];
  char control_digest[DIGEST_BYTES + 1U];
  char apply_digest[DIGEST_BYTES + 1U];
  char after_leaf[DIGEST_BYTES + 1U];
  char rollback_digest[DIGEST_BYTES + 1U];
  char restored_leaf[DIGEST_BYTES + 1U];
  RecordIdentity control_record;
  RecordIdentity apply_record;
  RecordIdentity rollback_record;
  bool has_apply;
} RollbackExistingItem;

typedef struct {
  size_t parent_index;
  Item create;
  UndoItem quarantine;
  char create_control_name[128];
  char create_receipt_name[128];
  char create_control_digest[DIGEST_BYTES + 1U];
  char create_receipt_digest[DIGEST_BYTES + 1U];
  RecordIdentity create_control_record;
  RecordIdentity create_receipt_record;
} RollbackItem;

typedef struct {
  char command;
  Request create_request;
  char request_digest[DIGEST_BYTES + 1U];
  char marker_digest[DIGEST_BYTES + 1U];
  uint64_t marker_length;
  char marker_identity[DIGEST_BYTES + 1U];
  /* WRCCHRJ2 single-authority journal: whole-content sha of the held journal
   * file (changes-history-transaction.json), verified by rollback_held_authority
   * against HELD_MARKER_FD. Distinct from marker_digest, which is the EXISTING
   * sub-request's active-marker domain digest embedded in EXISTING records. */
  char journal_digest[DIGEST_BYTES + 1U];
  char root_digest[DIGEST_BYTES + 1U];
  char recovery_digest[DIGEST_BYTES + 1U];
  char created_phase[DIGEST_BYTES + 1U];
  char prepared_history[DIGEST_BYTES + 1U];
  char precreate_updated_at[MAX_PATH_BYTES + 1U];
  char original_updated_at[MAX_PATH_BYTES + 1U];
  char existing_request[DIGEST_BYTES + 1U];
  char existing_terminal[DIGEST_BYTES + 1U];
  char existing_receipt_set[DIGEST_BYTES + 1U];
  char base_history[DIGEST_BYTES + 1U];
  uint64_t base_history_length;
  bool base_history_exists;
  char base_history_content[DIGEST_BYTES + 1U];
  char history_parent[DIGEST_BYTES + 1U];
  char base_history_identity[DIGEST_BYTES + 1U];
  size_t existing_count;
  size_t count;
  RollbackExistingItem existing[MAX_ITEMS];
  RollbackItem items[MAX_ITEMS];
  char final_name[128];
  char final_digest[DIGEST_BYTES + 1U];
  char rolled_phase[DIGEST_BYTES + 1U];
  char rolled_updated_at[MAX_PATH_BYTES + 1U];
  RecordIdentity final_record;
} RollbackRequest;


typedef enum { NAME_ABSENT = 0, NAME_EXACT = 1, NAME_FOREIGN = 2, NAME_ERROR = 3 } NameState;

static size_t input_bytes = 0U;
static size_t output_bytes = 0U;
static size_t output_limit = MAX_OUTPUT_BYTES;
static bool create_journal_capture = false;
static char create_journal_captured_state[16];
#ifdef WRITCRAFT_TEST_REQUIRE_CREATE_JOURNAL_BOUNDED_HASHES
static size_t create_journal_full_verifications = 0U;
static uint64_t create_journal_slice_hash_bytes = 0U;
static bool create_journal_command_active = false;
static size_t create_journal_artifact_full_hashes = 0U;
static size_t create_journal_frame_full_hashes = 0U;
#endif

#if defined(WRITCRAFT_TEST_PAUSE_CREATE_AFTER_PARENT_FSYNC) || \
    defined(WRITCRAFT_TEST_PAUSE_CREATE_AFTER_RECEIPT) || \
    defined(WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_AFTER_GUARD) || \
    defined(WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_AFTER_LEAF_GUARD) || \
    defined(WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_SECOND_CONTROL) || \
    defined(WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_SECOND_LEAF) || \
    defined(WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_AFTER_COMMIT) || \
    defined(WRITCRAFT_TEST_PAUSE_FINALIZE_AFTER_RECORDS) || \
    defined(WRITCRAFT_TEST_PAUSE_FINALIZE_AFTER_ACK) || \
    defined(WRITCRAFT_TEST_PAUSE_CREATE_CLEANUP_AFTER_G_FSYNC) || \
    defined(WRITCRAFT_TEST_PAUSE_CREATE_CLEANUP_AFTER_A_FSYNC) || \
    defined(WRITCRAFT_TEST_PAUSE_CONTROL_FAILURE_BEFORE_CLEANUP) || \
    defined(WRITCRAFT_TEST_PAUSE_CLEANUP_AFTER_RENAME) || \
    defined(WRITCRAFT_TEST_PAUSE_CLEANUP_AFTER_UNLINK) || \
    defined(WRITCRAFT_TEST_PAUSE_CLEANUP_AFTER_FSYNC) || \
    defined(WRITCRAFT_TEST_PAUSE_UNDO_AFTER_CONTROLS) || \
    defined(WRITCRAFT_TEST_PAUSE_UNDO_AFTER_RENAME) || \
    defined(WRITCRAFT_TEST_PAUSE_UNDO_AFTER_RECEIPT) || \
    defined(WRITCRAFT_TEST_PAUSE_UNDO_SETTLE_AFTER_MUTATION) || \
    defined(WRITCRAFT_TEST_PAUSE_UNDO_SETTLE_AFTER_FINAL) || \
    defined(WRITCRAFT_TEST_PAUSE_UNDO_ACK_BEFORE_CLEANUP) || \
    defined(WRITCRAFT_TEST_PAUSE_UNDO_ACK_AFTER_UNLINK) || \
    defined(WRITCRAFT_TEST_PAUSE_ROLLBACK_RECONCILE_BEFORE_UNCOMMITTED) || \
    defined(WRITCRAFT_TEST_PAUSE_ROLLBACK_AFTER_CONTROLS) || \
    defined(WRITCRAFT_TEST_PAUSE_ROLLBACK_AFTER_RECEIPT) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_PREFLIGHT) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_CONTROL) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_STAGE) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_SWAP) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_BEFORE_QUARANTINE) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_APPLY) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_COMMIT_CLEANUP) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_OLD_QUARANTINE) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_NEW_PUBLISH)
static bool __attribute__((unused)) test_sync_point(const char *name) {
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

static void digest_hex(const unsigned char digest[CC_SHA256_DIGEST_LENGTH], char out[65]) {
  static const char alphabet[] = "0123456789abcdef";
  for (size_t i = 0U; i < CC_SHA256_DIGEST_LENGTH; i += 1U) {
    out[i * 2U] = alphabet[digest[i] >> 4U];
    out[(i * 2U) + 1U] = alphabet[digest[i] & 0x0fU];
  }
  out[64] = '\0';
}

static void sha256_prefixed(const unsigned char *bytes, size_t length, char out[72]) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes, (CC_LONG)length, digest);
  memcpy(out, "sha256:", 7U);
  digest_hex(digest, out + 7U);
}

static bool digest_domain(const char *schema, const char *canonical, char out[72]) {
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

static bool write_line(const char *line) {
  size_t length = strlen(line);
  if (length > MAX_LINE_BYTES || length > output_limit || output_bytes > output_limit - length) {
    return false;
  }
  if (fputs(line, stdout) == EOF || fflush(stdout) != 0) return false;
  output_bytes += length;
  return true;
}

static bool write_create_journal_payload(const char *payload, size_t length) {
  if (length > MAX_CREATE_JOURNAL_OUTPUT_BYTES ||
      output_bytes > MAX_CREATE_JOURNAL_OUTPUT_BYTES - length) return false;
  if (fwrite(payload, 1U, length, stdout) != length || fflush(stdout) != 0) return false;
  output_bytes += length;
  return true;
}

static bool valid_digest(const char *value) {
  if (value == NULL || strlen(value) != DIGEST_BYTES || strncmp(value, "sha256:", 7U) != 0) return false;
  for (size_t i = 7U; i < DIGEST_BYTES; i += 1U) {
    if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
  }
  return true;
}

static bool valid_operation(const char *value) {
  if (value == NULL || strlen(value) != 52U || strncmp(value, "chr_", 4U) != 0) return false;
  for (size_t i = 4U; i < 52U; i += 1U) {
    if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
  }
  return true;
}

static bool valid_selected(const char *value) {
  size_t length = value == NULL ? 0U : strlen(value);
  if (length == 0U || length > MAX_SELECTED_BYTES) return false;
  for (size_t i = 0U; i < length; i += 1U) {
    char c = value[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
          (c >= '0' && c <= '9') || c == ':' || c == '_' || c == '-')) return false;
  }
  return true;
}

static bool parse_uint(const char *value, uint64_t maximum, uint64_t *out) {
  if (value == NULL || value[0] == '\0' || (value[0] == '0' && value[1] != '\0')) return false;
  uint64_t result = 0U;
  for (const char *c = value; *c != '\0'; c += 1U) {
    if (*c < '0' || *c > '9') return false;
    unsigned digit = (unsigned)(*c - '0');
    if (result > (maximum - digit) / 10U) return false;
    result = (result * 10U) + digit;
  }
  *out = result;
  return true;
}

static bool split_fields(char *line, char **fields, size_t maximum, size_t *count_out) {
  size_t count = 0U;
  char *cursor = line;
  while (cursor != NULL) {
    if (count >= maximum) return false;
    fields[count++] = cursor;
    char *tab = strchr(cursor, '\t');
    if (tab != NULL) *tab = '\0';
    cursor = tab == NULL ? NULL : tab + 1U;
  }
  *count_out = count;
  return true;
}

static bool read_protocol_line(char line[MAX_LINE_BYTES + 2U]) {
  if (fgets(line, (int)MAX_LINE_BYTES + 2, stdin) == NULL) return false;
  size_t length = strlen(line);
  if (length == 0U || length > MAX_LINE_BYTES || input_bytes > MAX_INPUT_BYTES - length ||
      line[length - 1U] != '\n') return false;
  input_bytes += length;
  line[length - 1U] = '\0';
  return true;
}

static bool protocol_eof(void) {
  int byte = fgetc(stdin);
  return byte == EOF && !ferror(stdin);
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

static int hex_value(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  return -1;
}

static bool decode_hex(const char *encoded, char *out, size_t capacity) {
  size_t length = encoded == NULL ? 0U : strlen(encoded);
  if (length == 0U || (length & 1U) != 0U || (length / 2U) >= capacity) return false;
  for (size_t i = 0U; i < length; i += 2U) {
    int high = hex_value(encoded[i]);
    int low = hex_value(encoded[i + 1U]);
    if (high < 0 || low < 0) return false;
    unsigned char value = (unsigned char)((high << 4) | low);
    if (value == 0U || value < 0x20U) return false;
    out[i / 2U] = (char)value;
  }
  out[length / 2U] = '\0';
  return true;
}

static bool timespec_ns(struct timespec value, intmax_t *out) {
  if (value.tv_nsec < 0 || value.tv_nsec >= 1000000000L) return false;
  *out = ((intmax_t)value.tv_sec * 1000000000L) + value.tv_nsec;
  return true;
}

static bool identity_from_stat(const struct stat *value, Identity *out) {
  intmax_t mtime_ns;
  intmax_t ctime_ns;
  if (!timespec_ns(value->st_mtimespec, &mtime_ns) || !timespec_ns(value->st_ctimespec, &ctime_ns)) return false;
  out->dev = (uintmax_t)value->st_dev;
  out->ino = (uintmax_t)value->st_ino;
  out->uid = (uintmax_t)value->st_uid;
  out->mode = (uintmax_t)value->st_mode;
  out->nlink = (uintmax_t)value->st_nlink;
  out->size = (uintmax_t)value->st_size;
  out->mtime_ns = mtime_ns;
  out->ctime_ns = ctime_ns;
  return true;
}

static uintmax_t permission_mode(uintmax_t mode) { return mode & 07777U; }

static bool same_directory(const Identity *left, const Identity *right) {
  return left->dev == right->dev && left->ino == right->ino && left->uid == right->uid &&
    left->mode == right->mode && S_ISDIR((mode_t)left->mode) && S_ISDIR((mode_t)right->mode);
}

static bool same_file(const Identity *left, const Identity *right) {
  return left->dev == right->dev && left->ino == right->ino && left->uid == right->uid &&
    left->mode == right->mode && left->nlink == right->nlink && left->size == right->size &&
    left->mtime_ns == right->mtime_ns && left->ctime_ns == right->ctime_ns &&
    S_ISREG((mode_t)left->mode) && S_ISREG((mode_t)right->mode);
}

static bool root_identity_digest(const Identity *identity, char out[72]) {
  char canonical[512];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX
    ",\"schema\":\"" ROOT_SCHEMA "\",\"uid\":%" PRIuMAX "}",
    identity->dev, identity->ino, permission_mode(identity->mode), identity->uid);
  return length > 0 && (size_t)length < sizeof(canonical) && digest_domain(ROOT_SCHEMA, canonical, out);
}

static bool object_identity_digest(const Identity *identity, const char *content, char out[72]) {
  if (identity->mtime_ns < 0 || identity->ctime_ns < 0) return false;
  char canonical[1024];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"contentSha256\":\"%s\",\"ctimeNs\":\"%" PRIuMAX "\",\"dev\":\"%" PRIuMAX
    "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX ",\"mtimeNs\":\"%" PRIuMAX
    "\",\"nlink\":%" PRIuMAX ",\"schema\":\"" OBJECT_SCHEMA "\",\"size\":\"%" PRIuMAX
    "\",\"uid\":%" PRIuMAX "}", content, (uintmax_t)identity->ctime_ns, identity->dev,
    identity->ino, permission_mode(identity->mode), (uintmax_t)identity->mtime_ns,
    identity->nlink, identity->size, identity->uid);
  return length > 0 && (size_t)length < sizeof(canonical) && digest_domain(OBJECT_SCHEMA, canonical, out);
}

static bool hash_fd(int fd, Identity *identity_out, char out[72], uint64_t maximum) {
  struct stat before_stat;
  Identity before;
  if (fstat(fd, &before_stat) != 0 || !identity_from_stat(&before_stat, &before) ||
      !S_ISREG(before_stat.st_mode) || before.size > maximum) return false;
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  unsigned char buffer[HASH_CHUNK_BYTES];
  uintmax_t offset = 0U;
  while (offset < before.size) {
    size_t wanted = before.size - offset > sizeof(buffer) ? sizeof(buffer) : (size_t)(before.size - offset);
    ssize_t got = pread(fd, buffer, wanted, (off_t)offset);
    if (got <= 0) return false;
    CC_SHA256_Update(&context, buffer, (CC_LONG)got);
    offset += (uintmax_t)got;
  }
  unsigned char raw[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(raw, &context);
  struct stat after_stat;
  Identity after;
  if (fstat(fd, &after_stat) != 0 || !identity_from_stat(&after_stat, &after) || !same_file(&before, &after)) return false;
  memcpy(out, "sha256:", 7U);
  digest_hex(raw, out + 7U);
  *identity_out = before;
  return true;
}

static bool hash_fd_with_existence(
  int fd, Identity *identity_out, char content_out[72], char existence_out[72],
  bool exists, uint64_t maximum
) {
  struct stat before_stat;
  Identity before;
  if (fstat(fd, &before_stat) != 0 || !identity_from_stat(&before_stat, &before) ||
      !S_ISREG(before_stat.st_mode) || before.size > maximum) return false;
  CC_SHA256_CTX content_context;
  CC_SHA256_CTX existence_context;
  CC_SHA256_Init(&content_context);
  CC_SHA256_Init(&existence_context);
  const unsigned char prefix = exists ? 0x01U : 0x00U;
  CC_SHA256_Update(&existence_context, &prefix, 1U);
  unsigned char buffer[HASH_CHUNK_BYTES];
  uintmax_t offset = 0U;
  while (offset < before.size) {
    size_t wanted = before.size - offset > sizeof(buffer)
      ? sizeof(buffer) : (size_t)(before.size - offset);
    ssize_t got = pread(fd, buffer, wanted, (off_t)offset);
    if (got <= 0) return false;
    CC_SHA256_Update(&content_context, buffer, (CC_LONG)got);
    CC_SHA256_Update(&existence_context, buffer, (CC_LONG)got);
    offset += (uintmax_t)got;
  }
  unsigned char content_raw[CC_SHA256_DIGEST_LENGTH];
  unsigned char existence_raw[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(content_raw, &content_context);
  CC_SHA256_Final(existence_raw, &existence_context);
  struct stat after_stat;
  Identity after;
  if (fstat(fd, &after_stat) != 0 || !identity_from_stat(&after_stat, &after) ||
      !same_file(&before, &after)) return false;
  memcpy(content_out, "sha256:", 7U);
  digest_hex(content_raw, content_out + 7U);
  memcpy(existence_out, "sha256:", 7U);
  digest_hex(existence_raw, existence_out + 7U);
  *identity_out = before;
  return true;
}

static bool split_absolute(RootBinding *root) {
  if (root->canonical[0] != '/' || strcmp(root->canonical, "/") == 0) return false;
  char *cursor = root->canonical + 1U;
  while (cursor != NULL) {
    if (root->component_count >= MAX_ROOT_COMPONENTS) return false;
    char *slash = strchr(cursor, '/');
    if (slash != NULL) *slash = '\0';
    if (cursor[0] == '\0' || strcmp(cursor, ".") == 0 || strcmp(cursor, "..") == 0) return false;
    root->components[root->component_count++] = cursor;
    cursor = slash == NULL ? NULL : slash + 1U;
  }
  return root->component_count > 0U;
}

static bool walk_project(RootBinding *root, bool capture, int *project_out) {
  int current = dup(TRUSTED_ROOT_FD);
  if (current < 0) return false;
  for (size_t i = 0U; i < root->component_count; i += 1U) {
    int child = openat(current, root->components[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (current != TRUSTED_ROOT_FD) (void)close(current);
    if (child < 0) return false;
    struct stat stat_value;
    Identity identity;
    if (fstat(child, &stat_value) != 0 || !identity_from_stat(&stat_value, &identity) ||
        !S_ISDIR(stat_value.st_mode) || (!capture && !same_directory(&identity, &root->component_identities[i]))) {
      (void)close(child);
      return false;
    }
    if (capture) root->component_identities[i] = identity;
    current = child;
  }
  *project_out = current;
  return true;
}

static bool open_recovery(RootBinding *root, bool capture) {
  int project = -1;
  if (!walk_project(root, capture, &project)) return false;
  int metadata = openat(project, ".writcraft", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int recovery = metadata < 0 ? -1 : openat(metadata, "recovery", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat project_stat;
  struct stat recovery_stat;
  Identity project_identity;
  Identity recovery_identity;
  char project_digest[72];
  char recovery_digest[72];
  bool valid = metadata >= 0 && recovery >= 0 && fstat(project, &project_stat) == 0 &&
    fstat(recovery, &recovery_stat) == 0 && identity_from_stat(&project_stat, &project_identity) &&
    identity_from_stat(&recovery_stat, &recovery_identity) && S_ISDIR(recovery_stat.st_mode) &&
    recovery_stat.st_uid == geteuid() && (recovery_stat.st_mode & 0777) == 0700 &&
    root_identity_digest(&project_identity, project_digest) &&
    root_identity_digest(&recovery_identity, recovery_digest) &&
    strcmp(project_digest, root->expected_root) == 0 && strcmp(recovery_digest, root->expected_recovery) == 0;
  if (metadata >= 0) (void)close(metadata);
  if (!valid) {
    if (recovery >= 0) (void)close(recovery);
    (void)close(project);
    return false;
  }
  if (capture) {
    root->project_fd = project;
    root->recovery_fd = recovery;
  } else {
    (void)close(project);
    (void)close(recovery);
  }
  return true;
}

static bool bind_root(char *line, RootBinding *root) {
  char *fields[4];
  size_t count = 0U;
  if (!split_fields(line, fields, 4U, &count) || count != 4U || strcmp(fields[0], "P") != 0 ||
      !decode_hex(fields[1], root->canonical, sizeof(root->canonical)) ||
      !strict_utf8((const unsigned char *)root->canonical, strlen(root->canonical)) ||
      !valid_digest(fields[2]) || !valid_digest(fields[3])) return false;
  memcpy(root->expected_root, fields[2], DIGEST_BYTES + 1U);
  memcpy(root->expected_recovery, fields[3], DIGEST_BYTES + 1U);
  return split_absolute(root) && open_recovery(root, true) && write_line("P\tOK\n");
}

static bool valid_public_path(const char *value) {
  size_t length = value == NULL ? 0U : strlen(value);
  if (length == 0U || length > MAX_PATH_BYTES || value[0] == '/' || strchr(value, '\\') != NULL) return false;
  const char *cursor = value;
  while (*cursor != '\0') {
    const char *slash = strchr(cursor, '/');
    size_t part = slash == NULL ? strlen(cursor) : (size_t)(slash - cursor);
    if (part == 0U || cursor[0] == '.') return false;
    cursor = slash == NULL ? cursor + part : slash + 1U;
  }
  return (length >= 3U && strcasecmp(value + length - 3U, ".md") == 0) ||
    (length >= 9U && strcasecmp(value + length - 9U, ".markdown") == 0);
}

static bool valid_journal_id(const char *value) {
  if (value == NULL || strlen(value) != 53U || strncmp(value, "chrj_", 5U) != 0) return false;
  for (size_t i = 5U; i < 53U; i += 1U) {
    if (!((value[i] >= '0' && value[i] <= '9') ||
          (value[i] >= 'a' && value[i] <= 'f'))) return false;
  }
  return true;
}

static bool parse_request_header(char *line, Request *request) {
  char *fields[8];
  size_t count = 0U;
  uint64_t item_count;
  if (!split_fields(line, fields, 8U, &count) || count != 8U ||
      !(strcmp(fields[0], "C") == 0 || strcmp(fields[0], "R") == 0) ||
      !valid_operation(fields[1]) || !valid_digest(fields[2]) || !valid_digest(fields[3]) ||
      !parse_uint(fields[4], MAX_ARTIFACT_BYTES, &request->artifact_length) ||
      request->artifact_length == 0U || !valid_digest(fields[5]) || !valid_digest(fields[6]) ||
      !parse_uint(fields[7], MAX_ITEMS, &item_count) || item_count == 0U) return false;
  request->command = fields[0][0];
  memcpy(request->operation, fields[1], strlen(fields[1]) + 1U);
  memcpy(request->artifact, fields[2], DIGEST_BYTES + 1U);
  memcpy(request->artifact_identity, fields[3], DIGEST_BYTES + 1U);
  memcpy(request->phase, fields[5], DIGEST_BYTES + 1U);
  memcpy(request->selection, fields[6], DIGEST_BYTES + 1U);
  request->count = (size_t)item_count;
  return true;
}

static bool parse_item(char *line, Request *request, size_t index) {
  char *fields[7];
  size_t count = 0U;
  Item *item = &request->items[index];
  if (!split_fields(line, fields, 7U, &count) || count != 7U || strcmp(fields[0], "I") != 0 ||
      !valid_selected(fields[1]) || !decode_hex(fields[2], item->path, sizeof(item->path)) ||
      !strict_utf8((const unsigned char *)item->path, strlen(item->path)) ||
      !valid_public_path(item->path) || !parse_uint(fields[3], request->artifact_length - 1U, &item->offset) ||
      !parse_uint(fields[4], request->artifact_length, &item->length) || item->length == 0U ||
      item->offset > request->artifact_length - item->length ||
      !valid_digest(fields[5]) || !valid_digest(fields[6])) return false;
  memcpy(item->selected, fields[1], strlen(fields[1]) + 1U);
  memcpy(item->content, fields[5], DIGEST_BYTES + 1U);
  memcpy(item->ancestor, fields[6], DIGEST_BYTES + 1U);
  for (size_t i = 0U; i < index; i += 1U) {
    Item *other = &request->items[i];
    if (strcmp(other->selected, item->selected) == 0 || strcmp(other->path, item->path) == 0 ||
        !(other->offset + other->length <= item->offset || item->offset + item->length <= other->offset)) return false;
  }
  return true;
}

static bool json_escape(const char *value, char *out, size_t capacity) {
  size_t used = 0U;
  for (const unsigned char *c = (const unsigned char *)value; *c != '\0'; c += 1U) {
    if (*c < 0x20U) return false;
    if (*c == '"' || *c == '\\') {
      if (used + 2U >= capacity) return false;
      out[used++] = '\\';
    } else if (used + 1U >= capacity) return false;
    out[used++] = (char)*c;
  }
  out[used] = '\0';
  return true;
}

static bool build_names_and_control(const Request *request, Item *item, char out[MAX_RECORD_BYTES + 1U]) {
  char key[1024];
  int length = snprintf(key, sizeof(key),
    "{\"artifactDigest\":\"%s\",\"operationId\":\"%s\",\"precreatePhaseDigest\":\"%s\""
    ",\"schema\":\"" RECORD_KEY_SCHEMA "\",\"selectedId\":\"%s\",\"selectionDigest\":\"%s\"}",
    request->artifact, request->operation, request->phase, item->selected, request->selection);
  char key_digest[72];
  if (length <= 0 || (size_t)length >= sizeof(key) || !digest_domain(RECORD_KEY_SCHEMA, key, key_digest)) return false;
  int c = snprintf(item->control_name, sizeof(item->control_name),
    ".changes-history-native-create-control.%s", key_digest + 7U);
  int r = snprintf(item->receipt_name, sizeof(item->receipt_name),
    ".changes-history-native-create-receipt.%s", key_digest + 7U);
  if (c <= 0 || r <= 0 || (size_t)c >= sizeof(item->control_name) ||
      (size_t)r >= sizeof(item->receipt_name)) return false;
  char escaped[MAX_PATH_BYTES * 2U + 1U];
  if (!json_escape(item->path, escaped, sizeof(escaped))) return false;
  char canonical[MAX_RECORD_BYTES + 1U];
  length = snprintf(canonical, sizeof(canonical),
    "{\"ancestorIdentityDigest\":\"%s\",\"artifactDigest\":\"%s\",\"artifactIdentityDigest\":\"%s\""
    ",\"artifactOffset\":%" PRIu64 ",\"byteLength\":%" PRIu64 ",\"contentDigest\":\"%s\""
    ",\"operationId\":\"%s\",\"path\":\"%s\",\"precreatePhaseDigest\":\"%s\""
    ",\"schema\":\"" CONTROL_SCHEMA "\",\"selectedId\":\"%s\",\"selectionDigest\":\"%s\"}",
    item->ancestor, request->artifact, request->artifact_identity, item->offset, item->length,
    item->content, request->operation, escaped, request->phase, item->selected, request->selection);
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(CONTROL_SCHEMA, canonical, item->control_digest)) return false;
  char path_hex[(MAX_PATH_BYTES * 2U) + 1U];
  static const char alphabet[] = "0123456789abcdef";
  size_t path_length = strlen(item->path);
  for (size_t i = 0U; i < path_length; i += 1U) {
    unsigned char byte = (unsigned char)item->path[i];
    path_hex[i * 2U] = alphabet[byte >> 4U];
    path_hex[(i * 2U) + 1U] = alphabet[byte & 0x0fU];
  }
  path_hex[path_length * 2U] = '\0';
  length = snprintf(out, MAX_RECORD_BYTES + 1U,
    CONTROL_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%" PRIu64 "\t%" PRIu64
    "\t%s\t%s\t%s\n", request->operation, item->selected, path_hex, request->artifact,
    request->artifact_identity, request->phase, request->selection, item->offset, item->length,
    item->content, item->ancestor, item->control_digest);
  return length > 0 && length <= (int)MAX_RECORD_BYTES;
}

static bool build_receipt(const Request *request, Item *item, char out[MAX_RECORD_BYTES + 1U]) {
  char canonical[2048];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"byteLength\":%" PRIu64 ",\"contentDigest\":\"%s\",\"controlDigest\":\"%s\""
    ",\"createdIdentityDigest\":\"%s\",\"fileFsyncComplete\":true,\"operationId\":\"%s\""
    ",\"parentFsyncComplete\":true,\"recoveryFsyncComplete\":true,\"schema\":\"" RECEIPT_SCHEMA
    "\",\"selectedId\":\"%s\"}", item->length, item->content, item->control_digest,
    item->created_digest, request->operation, item->selected);
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(RECEIPT_SCHEMA, canonical, item->receipt_digest)) return false;
  length = snprintf(out, MAX_RECORD_BYTES + 1U,
    RECEIPT_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%" PRIu64 "\t1\t1\t1\t%s\n",
    request->operation, item->selected, item->control_digest, item->created_digest,
    item->content, item->length, item->receipt_digest);
  return length > 0 && length <= (int)MAX_RECORD_BYTES;
}

static NameState record_state(int directory, const char *name, const char *expected) {
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? NAME_ABSENT : NAME_ERROR;
  struct stat stat_value;
  size_t expected_length = strlen(expected);
  char bytes[MAX_RECORD_BYTES + 1U];
  ssize_t count = pread(fd, bytes, MAX_RECORD_BYTES + 1U, 0);
  bool exact = fstat(fd, &stat_value) == 0 && S_ISREG(stat_value.st_mode) &&
    stat_value.st_uid == geteuid() && (stat_value.st_mode & 0777) == 0600 &&
    stat_value.st_nlink == 1 && count == (ssize_t)expected_length &&
    memcmp(bytes, expected, expected_length) == 0;
  (void)close(fd);
  return exact ? NAME_EXACT : NAME_FOREIGN;
}

static bool has_prefix(const char *value, const char *prefix) {
  return strncmp(value, prefix, strlen(prefix)) == 0;
}

static bool read_namespace_record(int directory, const char *name, char bytes[MAX_RECORD_BYTES + 1U]) {
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat stat_value;
  ssize_t count = pread(fd, bytes, MAX_RECORD_BYTES + 1U, 0);
  bool valid = count > 0 && count <= (ssize_t)MAX_RECORD_BYTES &&
    fstat(fd, &stat_value) == 0 && S_ISREG(stat_value.st_mode) &&
    stat_value.st_uid == geteuid() && (stat_value.st_mode & 0777) == 0600 &&
    stat_value.st_nlink == 1;
  (void)close(fd);
  if (!valid) return false;
  bytes[count] = '\0';
  return true;
}

static bool current_record_namespace_clean(
  int directory, const Request *request,
  const char (*controls)[MAX_RECORD_BYTES + 1U],
  const char *final_name, const char *final_record
) {
  int scan_fd = dup(directory);
  if (scan_fd < 0) return false;
  DIR *stream = fdopendir(scan_fd);
  if (stream == NULL) {
    (void)close(scan_fd);
    return false;
  }
  bool clean = true;
  size_t entries = 0U;
  struct dirent *entry;
  while (true) {
    errno = 0;
    entry = readdir(stream);
    if (entry == NULL) {
      if (errno != 0) clean = false;
      break;
    }
    const char *name = entry->d_name;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
    entries += 1U;
    if (entries > MAX_RECOVERY_ENTRIES) { clean = false; break; }
    bool native_create = has_prefix(name, ".changes-history-native-create-control.") ||
      has_prefix(name, ".changes-history-native-create-receipt.") ||
      has_prefix(name, ".changes-history-native-create-final.");
    if (!native_create) continue;
    bool expected_name = final_name != NULL && strcmp(name, final_name) == 0;
    if (request != NULL) {
      for (size_t i = 0U; i < request->count && !expected_name; i += 1U) {
        expected_name = strcmp(name, request->items[i].control_name) == 0 ||
          strcmp(name, request->items[i].receipt_name) == 0;
      }
    }
    if (expected_name) continue;
    char bytes[MAX_RECORD_BYTES + 1U];
    if (!read_namespace_record(directory, name, bytes)) continue;
    if (final_record != NULL && strcmp(bytes, final_record) == 0) {
      clean = false;
      break;
    }
    if (request == NULL) continue;
    for (size_t i = 0U; i < request->count; i += 1U) {
      if (controls != NULL && strcmp(bytes, controls[i]) == 0) {
        clean = false;
        break;
      }
      char prefix[512];
      int length = snprintf(prefix, sizeof(prefix), CONTROL_SCHEMA "\t%s\t%s\t",
        request->operation, request->items[i].selected);
      if (length <= 0 || (size_t)length >= sizeof(prefix)) { clean = false; break; }
      if (has_prefix(bytes, prefix)) { clean = false; break; }
      length = snprintf(prefix, sizeof(prefix), RECEIPT_SCHEMA "\t%s\t%s\t%s\t",
        request->operation, request->items[i].selected, request->items[i].control_digest);
      if (length <= 0 || (size_t)length >= sizeof(prefix)) { clean = false; break; }
      if (has_prefix(bytes, prefix)) { clean = false; break; }
    }
    if (!clean) break;
  }
  (void)closedir(stream);
  return clean;
}

static bool record_write_failed(int fd, RecordAttempt *attempt) {
  if (attempt == NULL) {
    (void)close(fd);
    return false;
  }
  struct stat stat_value;
  Identity identity;
  if (fstat(fd, &stat_value) == 0 && identity_from_stat(&stat_value, &identity)) {
    attempt->identity = identity;
    attempt->identity_bound = true;
  }
  attempt->fd = fd;
  return false;
}

static bool write_record(
  int directory, const char *name, const char *bytes,
  Identity *identity_out, RecordAttempt *attempt
) {
  if (attempt != NULL) {
    memset(attempt, 0, sizeof(*attempt));
    attempt->fd = -1;
  }
  int fd = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  if (attempt != NULL) {
    attempt->created = true;
    attempt->fd = fd;
  }
  (void)fchmod(fd, 0600);
  bool protected_control = has_prefix(name, ".changes-history-native-create-control.") ||
    has_prefix(name, ".changes-history-native-undo-control.") ||
    has_prefix(name, ".changes-history-native-rollback-create-control.") ||
    has_prefix(name, ".changes-history-native-existing-control.");
  bool protected_existing_apply =
    has_prefix(name, ".changes-history-native-existing-apply.");
  (void)protected_control;
  (void)protected_existing_apply;
  size_t length = strlen(bytes);
  size_t offset = 0U;
  while (offset < length) {
    size_t wanted = length - offset;
#ifdef WRITCRAFT_TEST_CONTROL_PARTIAL_WRITE
    if (protected_control && offset == 0U) wanted = 1U;
#endif
#ifdef WRITCRAFT_TEST_EXISTING_APPLY_PARTIAL_WRITE
    if (protected_existing_apply && offset == 0U) wanted = 1U;
#endif
    ssize_t wrote = write(fd, bytes + offset, wanted);
    if (wrote <= 0) return record_write_failed(fd, attempt);
    offset += (size_t)wrote;
    if (attempt != NULL) attempt->bytes_written = offset;
#ifdef WRITCRAFT_TEST_CONTROL_PARTIAL_WRITE
    if (protected_control) return record_write_failed(fd, attempt);
#endif
#ifdef WRITCRAFT_TEST_EXISTING_APPLY_PARTIAL_WRITE
    if (protected_existing_apply) return record_write_failed(fd, attempt);
#endif
  }
#ifdef WRITCRAFT_TEST_CONTROL_FILE_FSYNC_FAILURE
  if (protected_control) return record_write_failed(fd, attempt);
#endif
#ifdef WRITCRAFT_TEST_EXISTING_APPLY_FILE_FSYNC_FAILURE
  if (protected_existing_apply) return record_write_failed(fd, attempt);
#endif
  struct stat held_stat;
  struct stat path_stat;
  Identity held_identity;
  Identity path_identity;
  if (fsync(fd) != 0) return record_write_failed(fd, attempt);
#ifdef WRITCRAFT_TEST_CONTROL_PATH_RECHECK_FAILURE
  if (protected_control) return record_write_failed(fd, attempt);
#endif
#ifdef WRITCRAFT_TEST_EXISTING_APPLY_PATH_RECHECK_FAILURE
  if (protected_existing_apply) return record_write_failed(fd, attempt);
#endif
  if (fstat(fd, &held_stat) != 0 ||
      fstatat(directory, name, &path_stat, AT_SYMLINK_NOFOLLOW) != 0 ||
      !identity_from_stat(&held_stat, &held_identity) ||
      !identity_from_stat(&path_stat, &path_identity) ||
      !same_file(&held_identity, &path_identity)) return record_write_failed(fd, attempt);
#ifdef WRITCRAFT_TEST_CONTROL_DIR_FSYNC_FAILURE
  if (protected_control) return record_write_failed(fd, attempt);
#endif
#ifdef WRITCRAFT_TEST_EXISTING_APPLY_DIR_FSYNC_FAILURE
  if (protected_existing_apply) return record_write_failed(fd, attempt);
#endif
  if (fsync(directory) != 0) return record_write_failed(fd, attempt);
  if (identity_out != NULL) *identity_out = held_identity;
  (void)close(fd);
  if (attempt != NULL) {
    attempt->identity = held_identity;
    attempt->identity_bound = true;
    attempt->fd = -1;
  }
  return true;
}

static bool same_bound_record(const Identity *left, const Identity *right) {
  return left->dev == right->dev && left->ino == right->ino &&
    left->uid == right->uid && left->mode == right->mode &&
    left->nlink == right->nlink && left->size == right->size &&
    S_ISREG((mode_t)left->mode) && S_ISREG((mode_t)right->mode);
}

static NameState open_record_exact(
  int directory, const char *name, const char *expected, int *fd_out, Identity *identity_out
) {
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? NAME_ABSENT : NAME_ERROR;
  struct stat stat_value;
  size_t expected_length = strlen(expected);
  char bytes[MAX_RECORD_BYTES + 1U];
  ssize_t count = pread(fd, bytes, MAX_RECORD_BYTES + 1U, 0);
  Identity identity;
  bool exact = fstat(fd, &stat_value) == 0 && identity_from_stat(&stat_value, &identity) &&
    S_ISREG(stat_value.st_mode) && stat_value.st_uid == geteuid() &&
    (stat_value.st_mode & 0777) == 0600 && stat_value.st_nlink == 1 &&
    count == (ssize_t)expected_length && memcmp(bytes, expected, expected_length) == 0;
  if (!exact) {
    (void)close(fd);
    return NAME_FOREIGN;
  }
  *fd_out = fd;
  *identity_out = identity;
  return NAME_EXACT;
}

static bool record_path_matches_fd(int directory, const char *name, int fd) {
  struct stat path_stat;
  struct stat held_stat;
  Identity path_identity;
  Identity held_identity;
  return fstatat(directory, name, &path_stat, AT_SYMLINK_NOFOLLOW) == 0 &&
    fstat(fd, &held_stat) == 0 && identity_from_stat(&path_stat, &path_identity) &&
    identity_from_stat(&held_stat, &held_identity) && same_file(&path_identity, &held_identity);
}

static bool record_identity_matches(
  int directory, const char *name, const char *expected, const Identity *expected_identity
) {
  int fd = -1;
  Identity identity;
  bool exact = open_record_exact(directory, name, expected, &fd, &identity) == NAME_EXACT &&
    same_file(&identity, expected_identity) && record_path_matches_fd(directory, name, fd);
  if (fd >= 0) (void)close(fd);
  return exact;
}

static bool random_record_quarantine(char out[96]) {
  unsigned char random[16];
  char hex[33];
  static const char alphabet[] = "0123456789abcdef";
  arc4random_buf(random, sizeof(random));
  for (size_t index = 0U; index < sizeof(random); index += 1U) {
    hex[index * 2U] = alphabet[random[index] >> 4U];
    hex[(index * 2U) + 1U] = alphabet[random[index] & 0x0fU];
  }
  hex[32] = '\0';
  int length = snprintf(out, 96U, ".changes-history-cleanup.%s", hex);
  return length > 0 && length < 96;
}

static bool existing_stage_write_failed(int fd, ExistingStageAttempt *attempt) {
  if (attempt != NULL && fd >= 0) {
    struct stat value;
    Identity identity;
    if (fstat(fd, &value) == 0 && identity_from_stat(&value, &identity)) {
      attempt->identity = identity;
      attempt->identity_bound = true;
    }
    attempt->fd = -1;
  }
  if (fd >= 0) (void)close(fd);
  return false;
}

static bool __attribute__((unused)) existing_stage_write(
  int directory,
  const char *name,
  uint64_t after_offset,
  uint64_t after_length,
  const char *after_content,
  ExistingStageAttempt *attempt,
  Identity *identity_out
) {
  if (attempt == NULL || name == NULL || after_content == NULL) return false;
  memset(attempt, 0, sizeof(*attempt));
  attempt->fd = -1;
  int fd = openat(directory, name,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  attempt->created = true;
  attempt->fd = fd;
  (void)fchmod(fd, 0600);
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  unsigned char buffer[HASH_CHUNK_BYTES];
  uint64_t offset = 0U;
  while (offset < after_length) {
    size_t wanted = after_length - offset > sizeof(buffer)
      ? sizeof(buffer) : (size_t)(after_length - offset);
    ssize_t got = pread(HELD_ARTIFACT_FD, buffer, wanted,
      (off_t)(after_offset + offset));
    if (got <= 0) return existing_stage_write_failed(fd, attempt);
    CC_SHA256_Update(&context, buffer, (CC_LONG)got);
    size_t write_length = (size_t)got;
#ifdef WRITCRAFT_TEST_EXISTING_STAGE_PARTIAL_WRITE
    if (offset == 0U && write_length > 1U) write_length = 1U;
#endif
    size_t written = 0U;
    while (written < write_length) {
      ssize_t count = write(fd, buffer + written, write_length - written);
      if (count <= 0) return existing_stage_write_failed(fd, attempt);
      written += (size_t)count;
      attempt->bytes_written += (uint64_t)count;
    }
#ifdef WRITCRAFT_TEST_EXISTING_STAGE_PARTIAL_WRITE
    if (write_length != (size_t)got) return existing_stage_write_failed(fd, attempt);
#endif
    offset += (uint64_t)got;
  }
  unsigned char raw[CC_SHA256_DIGEST_LENGTH];
  char content[72];
  CC_SHA256_Final(raw, &context);
  memcpy(content, "sha256:", 7U);
  digest_hex(raw, content + 7U);
  if (strcmp(content, after_content) != 0) return existing_stage_write_failed(fd, attempt);
#ifdef WRITCRAFT_TEST_EXISTING_STAGE_FILE_FSYNC_FAILURE
  return existing_stage_write_failed(fd, attempt);
#else
  if (fsync(fd) != 0) return existing_stage_write_failed(fd, attempt);
#endif
  struct stat held_stat;
  struct stat path_stat;
  Identity held_identity;
  Identity path_identity;
  if (fstat(fd, &held_stat) != 0 || fstatat(directory, name, &path_stat,
      AT_SYMLINK_NOFOLLOW) != 0 || !identity_from_stat(&held_stat, &held_identity) ||
      !identity_from_stat(&path_stat, &path_identity) ||
      held_identity.size != after_length ||
      !same_file(&held_identity, &path_identity)) {
    return existing_stage_write_failed(fd, attempt);
  }
#ifdef WRITCRAFT_TEST_EXISTING_STAGE_PATH_RECHECK_FAILURE
  return existing_stage_write_failed(fd, attempt);
#endif
#ifdef WRITCRAFT_TEST_EXISTING_STAGE_DIR_FSYNC_FAILURE
  return existing_stage_write_failed(fd, attempt);
#else
  if (fsync(directory) != 0) return existing_stage_write_failed(fd, attempt);
#endif
  attempt->identity = held_identity;
  attempt->identity_bound = true;
  if (identity_out != NULL) *identity_out = held_identity;
  (void)close(fd);
  attempt->fd = -1;
  return true;
}

static bool __attribute__((unused)) existing_stage_remove_exact(
  int directory, const char *name, const Identity *expected_identity,
  const char *expected_digest, uint64_t expected_length
) {
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT;
  Identity identity;
  char content[72];
  bool exact = hash_fd(fd, &identity, content, MAX_ARTIFACT_BYTES) &&
    expected_identity != NULL && same_bound_record(&identity, expected_identity) &&
    identity.mtime_ns == expected_identity->mtime_ns &&
    identity.size == expected_length && strcmp(content, expected_digest) == 0 &&
    record_path_matches_fd(directory, name, fd);
  if (!exact) { (void)close(fd); return false; }
  char quarantine[96];
  struct stat ignored;
  bool moved = random_record_quarantine(quarantine) &&
    fstatat(directory, quarantine, &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT &&
    renameatx_np(directory, name, directory, quarantine, RENAME_EXCL) == 0;
  if (!moved) { (void)close(fd); return false; }
  int held = openat(directory, quarantine, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity quarantine_identity;
  char quarantine_content[72];
  exact = fstatat(directory, name, &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT &&
    held >= 0 && hash_fd(held, &quarantine_identity, quarantine_content, MAX_ARTIFACT_BYTES) &&
    same_bound_record(&quarantine_identity, expected_identity) &&
    quarantine_identity.mtime_ns == expected_identity->mtime_ns &&
    quarantine_identity.size == expected_length &&
    strcmp(quarantine_content, expected_digest) == 0 &&
    record_path_matches_fd(directory, quarantine, held) &&
    unlinkat(directory, quarantine, 0) == 0;
  if (held >= 0) (void)close(held);
  (void)close(fd);
  return exact && fsync(directory) == 0;
}

static bool unlink_exact_record_owned(
  int directory, const char *name, const char *expected,
  const Identity *created_identity, int created_fd
) {
  int held_fd = -1;
  Identity held_identity;
  if (open_record_exact(directory, name, expected, &held_fd, &held_identity) != NAME_EXACT ||
      (created_identity != NULL && !same_file(&held_identity, created_identity))) {
    if (held_fd >= 0) (void)close(held_fd);
    return false;
  }
  if (created_fd >= 0) {
    struct stat created_stat;
    Identity current_created_identity;
    if (created_identity == NULL || fstat(created_fd, &created_stat) != 0 ||
        !identity_from_stat(&created_stat, &current_created_identity) ||
        !same_file(&current_created_identity, created_identity) ||
        !same_file(&current_created_identity, &held_identity)) {
      (void)close(held_fd);
      return false;
    }
  }
#ifdef WRITCRAFT_TEST_LATE_CONTROL_CLEANUP_REPLACEMENT
  static bool injected = false;
  if (!injected) {
    injected = true;
    const char held_name[] = ".changes-history-cleanup.test-held-control";
    if (renameatx_np(directory, name, directory, held_name, RENAME_EXCL) == 0) {
      int foreign = openat(directory, name,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
      if (foreign >= 0) {
        static const char foreign_bytes[] = "foreign control replacement\n";
        (void)write(foreign, foreign_bytes, sizeof(foreign_bytes) - 1U);
        (void)fsync(foreign);
        (void)close(foreign);
        (void)fsync(directory);
      }
    }
  }
#endif
  char quarantine[96];
  struct stat ignored;
  bool ready = random_record_quarantine(quarantine) &&
    fstatat(directory, quarantine, &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT &&
    record_path_matches_fd(directory, name, held_fd) &&
    renameatx_np(directory, name, directory, quarantine, RENAME_EXCL) == 0;
  if (!ready) {
    (void)close(held_fd);
    return false;
  }
#ifdef WRITCRAFT_TEST_PAUSE_CLEANUP_AFTER_RENAME
  if (!test_sync_point("cleanup-after-rename")) {
    (void)close(held_fd);
    return false;
  }
#endif
  bool source_absent = fstatat(directory, name, &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
  int quarantine_fd = -1;
  Identity quarantine_identity;
  bool exact = source_absent &&
    open_record_exact(directory, quarantine, expected, &quarantine_fd, &quarantine_identity) == NAME_EXACT &&
    same_bound_record(&held_identity, &quarantine_identity) &&
    record_path_matches_fd(directory, quarantine, quarantine_fd) &&
    (created_identity == NULL || quarantine_identity.mtime_ns == created_identity->mtime_ns);
  if (exact && created_fd >= 0) {
    struct stat created_stat;
    Identity current_created_identity;
    exact = fstat(created_fd, &created_stat) == 0 &&
      identity_from_stat(&created_stat, &current_created_identity) &&
      same_bound_record(&current_created_identity, &quarantine_identity) &&
      current_created_identity.mtime_ns == created_identity->mtime_ns;
  }
  if (!exact || unlinkat(directory, quarantine, 0) != 0) {
    if (quarantine_fd >= 0) (void)close(quarantine_fd);
    (void)close(held_fd);
    return false;
  }
#ifdef WRITCRAFT_TEST_PAUSE_CLEANUP_AFTER_UNLINK
  if (!test_sync_point("cleanup-after-unlink")) {
    (void)close(quarantine_fd);
    (void)close(held_fd);
    return false;
  }
#endif
  (void)close(quarantine_fd);
  (void)close(held_fd);
  return fsync(directory) == 0;
}

static bool unlink_exact_record(int directory, const char *name, const char *expected) {
  return unlink_exact_record_owned(directory, name, expected, NULL, -1);
}

static bool unlink_attempted_record_owned(
  int directory, const char *name, const char *expected, const RecordAttempt *attempt
) {
  if (attempt == NULL || !attempt->created || !attempt->identity_bound || attempt->fd < 0 ||
      attempt->bytes_written > strlen(expected) ||
      attempt->identity.size != (uintmax_t)attempt->bytes_written) return false;
  struct stat created_stat;
  Identity created_identity;
  if (fstat(attempt->fd, &created_stat) != 0 ||
      !identity_from_stat(&created_stat, &created_identity) ||
      !same_file(&created_identity, &attempt->identity)) return false;
  int held_fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (held_fd < 0) return false;
  struct stat held_stat;
  Identity held_identity;
  char bytes[MAX_RECORD_BYTES + 1U];
  ssize_t count = pread(held_fd, bytes, MAX_RECORD_BYTES + 1U, 0);
  bool exact = fstat(held_fd, &held_stat) == 0 &&
    identity_from_stat(&held_stat, &held_identity) &&
    same_file(&held_identity, &attempt->identity) &&
    count == (ssize_t)attempt->bytes_written &&
    memcmp(bytes, expected, attempt->bytes_written) == 0 &&
    record_path_matches_fd(directory, name, held_fd);
  if (!exact) {
    (void)close(held_fd);
    return false;
  }
  char quarantine[96];
  struct stat ignored;
  bool moved = random_record_quarantine(quarantine) &&
    fstatat(directory, quarantine, &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT &&
    record_path_matches_fd(directory, name, held_fd) &&
    fstat(attempt->fd, &created_stat) == 0 &&
    identity_from_stat(&created_stat, &created_identity) &&
    same_file(&created_identity, &attempt->identity) &&
    renameatx_np(directory, name, directory, quarantine, RENAME_EXCL) == 0;
  if (!moved) {
    (void)close(held_fd);
    return false;
  }
  int quarantine_fd = openat(directory, quarantine, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity quarantine_identity;
  count = quarantine_fd >= 0 ? pread(quarantine_fd, bytes, MAX_RECORD_BYTES + 1U, 0) : -1;
  exact = fstatat(directory, name, &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT &&
    quarantine_fd >= 0 && fstat(quarantine_fd, &held_stat) == 0 &&
    identity_from_stat(&held_stat, &quarantine_identity) &&
    same_file(&quarantine_identity, &attempt->identity) &&
    count == (ssize_t)attempt->bytes_written &&
    memcmp(bytes, expected, attempt->bytes_written) == 0 &&
    record_path_matches_fd(directory, quarantine, quarantine_fd) &&
    fstat(attempt->fd, &created_stat) == 0 &&
    identity_from_stat(&created_stat, &created_identity) &&
    same_file(&created_identity, &attempt->identity);
  if (!exact || unlinkat(directory, quarantine, 0) != 0) {
    if (quarantine_fd >= 0) (void)close(quarantine_fd);
    (void)close(held_fd);
    return false;
  }
  (void)close(quarantine_fd);
  (void)close(held_fd);
  return fsync(directory) == 0;
}

static bool open_parent(
  RootBinding *root, const char *path, Ancestor ancestors[MAX_ROOT_COMPONENTS],
  size_t *depth_out, int *parent_out, char leaf[MAX_PATH_BYTES + 1U], char ancestor_digest[72]
) {
  char copy[MAX_PATH_BYTES + 1U];
  memcpy(copy, path, strlen(path) + 1U);
  char *parts[MAX_ROOT_COMPONENTS];
  size_t count = 0U;
  char *cursor = copy;
  while (cursor != NULL) {
    if (count >= MAX_ROOT_COMPONENTS) return false;
    char *slash = strchr(cursor, '/');
    if (slash != NULL) *slash = '\0';
    parts[count++] = cursor;
    cursor = slash == NULL ? NULL : slash + 1U;
  }
  int parent = dup(root->project_fd);
  if (parent < 0) return false;
  size_t depth = 0U;
  for (size_t i = 0U; i + 1U < count; i += 1U) {
    int child = openat(parent, parts[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (child < 0) goto fail;
    struct stat stat_value;
    Identity identity;
    if (fstat(child, &stat_value) != 0 || !identity_from_stat(&stat_value, &identity) ||
        !S_ISDIR(stat_value.st_mode)) { (void)close(child); goto fail; }
    memcpy(ancestors[depth].name, parts[i], strlen(parts[i]) + 1U);
    ancestors[depth].identity = identity;
    ancestors[depth].fd = child;
    if (depth == 0U) (void)close(parent);
    parent = child;
    depth += 1U;
  }
  memcpy(leaf, parts[count - 1U], strlen(parts[count - 1U]) + 1U);
  size_t capacity = 128U + (depth * 384U);
  char *canonical = malloc(capacity);
  if (canonical == NULL) goto fail;
  size_t used = (size_t)snprintf(canonical, capacity, "{\"components\":[");
  bool valid = used < capacity;
  for (size_t i = 0U; valid && i < depth; i += 1U) {
    char name_digest[72];
    sha256_prefixed((const unsigned char *)ancestors[i].name, strlen(ancestors[i].name), name_digest);
    int length = snprintf(canonical + used, capacity - used,
      "%s{\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX
      ",\"nameSha256\":\"%s\",\"uid\":%" PRIuMAX "}", i == 0U ? "" : ",",
      ancestors[i].identity.dev, ancestors[i].identity.ino, permission_mode(ancestors[i].identity.mode),
      name_digest, ancestors[i].identity.uid);
    valid = length > 0 && (size_t)length < capacity - used;
    if (valid) used += (size_t)length;
  }
  if (valid) {
    int length = snprintf(canonical + used, capacity - used, "],\"schema\":\"" ANCESTOR_SCHEMA "\"}");
    valid = length > 0 && (size_t)length < capacity - used && digest_domain(ANCESTOR_SCHEMA, canonical, ancestor_digest);
  }
  free(canonical);
  if (!valid) goto fail;
  *depth_out = depth;
  *parent_out = parent;
  return true;
fail:
  for (size_t i = 0U; i < depth; i += 1U) if (ancestors[i].fd >= 0) (void)close(ancestors[i].fd);
  if (depth == 0U && parent >= 0) (void)close(parent);
  return false;
}

static bool revalidate_parent(RootBinding *root, Ancestor *ancestors, size_t depth) {
  int parent = root->project_fd;
  for (size_t i = 0U; i < depth; i += 1U) {
    struct stat held_stat;
    struct stat path_stat;
    Identity held;
    Identity at_path;
    if (fstat(ancestors[i].fd, &held_stat) != 0 ||
        fstatat(parent, ancestors[i].name, &path_stat, AT_SYMLINK_NOFOLLOW) != 0 ||
        !identity_from_stat(&held_stat, &held) || !identity_from_stat(&path_stat, &at_path) ||
        !same_directory(&ancestors[i].identity, &held) || !same_directory(&ancestors[i].identity, &at_path)) return false;
    parent = ancestors[i].fd;
  }
  return open_recovery(root, false);
}

static void close_parent(Ancestor *ancestors, size_t depth, int parent) {
  (void)parent;
  for (size_t i = 0U; i < depth; i += 1U) if (ancestors[i].fd >= 0) (void)close(ancestors[i].fd);
  if (depth == 0U && parent >= 0) (void)close(parent);
}

static bool created_identity_digest(
  const Identity *identity, const char *parent_digest, const char *leaf,
  const char *content, char out[72]
) {
  char leaf_digest[72];
  sha256_prefixed((const unsigned char *)leaf, strlen(leaf), leaf_digest);
  char canonical[1536];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"contentSha256\":\"%s\",\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX
    "\",\"leafNameSha256\":\"%s\",\"mode\":%" PRIuMAX ",\"nlink\":%" PRIuMAX
    ",\"parentIdentityDigest\":\"%s\",\"schema\":\"" CREATED_SCHEMA "\",\"size\":\"%" PRIuMAX
    "\",\"uid\":%" PRIuMAX "}", content, identity->dev, identity->ino, leaf_digest,
    permission_mode(identity->mode), identity->nlink, parent_digest, identity->size, identity->uid);
  return length > 0 && (size_t)length < sizeof(canonical) && digest_domain(CREATED_SCHEMA, canonical, out);
}

static bool create_identity_digest(
  const Identity *identity, const char *parent_digest, const char *leaf,
  const char *content, char out[72]
) {
  if (create_journal_capture) return object_identity_digest(identity, content, out);
  return created_identity_digest(identity, parent_digest, leaf, content, out);
}

static bool artifact_valid_bound(const Request *request, Identity *identity_out) {
#ifdef WRITCRAFT_TEST_REQUIRE_CREATE_JOURNAL_BOUNDED_HASHES
  if (create_journal_command_active) create_journal_artifact_full_hashes += 1U;
#endif
  int flags = fcntl(HELD_ARTIFACT_FD, F_GETFL);
  Identity identity;
  char content[72];
  char identity_digest[72];
  bool valid = flags >= 0 && (flags & O_ACCMODE) == O_RDONLY &&
    hash_fd(HELD_ARTIFACT_FD, &identity, content, MAX_ARTIFACT_BYTES) &&
    identity.uid == (uintmax_t)geteuid() && permission_mode(identity.mode) == 0600U &&
    identity.nlink == 1U && identity.size == request->artifact_length &&
    strcmp(content, request->artifact) == 0 && object_identity_digest(&identity, content, identity_digest) &&
    strcmp(identity_digest, request->artifact_identity) == 0;
  if (valid && identity_out != NULL) *identity_out = identity;
  return valid;
}

static bool artifact_valid(const Request *request) {
  return artifact_valid_bound(request, NULL);
}

static bool artifact_segment_valid(const Item *item) {
#ifdef WRITCRAFT_TEST_REQUIRE_CREATE_JOURNAL_BOUNDED_HASHES
  if (create_journal_capture) {
    if (item->length > UINT64_MAX - create_journal_slice_hash_bytes) return false;
    create_journal_slice_hash_bytes += item->length;
  }
#endif
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  unsigned char buffer[HASH_CHUNK_BYTES];
  uint64_t offset = 0U;
  while (offset < item->length) {
    size_t wanted = item->length - offset > sizeof(buffer) ? sizeof(buffer) : (size_t)(item->length - offset);
    ssize_t got = pread(HELD_ARTIFACT_FD, buffer, wanted, (off_t)(item->offset + offset));
    if (got <= 0) return false;
    CC_SHA256_Update(&context, buffer, (CC_LONG)got);
    offset += (uint64_t)got;
  }
  unsigned char raw[CC_SHA256_DIGEST_LENGTH];
  char digest[72];
  CC_SHA256_Final(raw, &context);
  memcpy(digest, "sha256:", 7U);
  digest_hex(raw, digest + 7U);
  return strcmp(digest, item->content) == 0;
}

static bool write_artifact_segment(int leaf_fd, const Item *item) {
  unsigned char buffer[HASH_CHUNK_BYTES];
  uint64_t offset = 0U;
  while (offset < item->length) {
    size_t wanted = item->length - offset > sizeof(buffer) ? sizeof(buffer) : (size_t)(item->length - offset);
    ssize_t got = pread(HELD_ARTIFACT_FD, buffer, wanted, (off_t)(item->offset + offset));
    if (got <= 0) return false;
#ifdef WRITCRAFT_TEST_PARTIAL_WRITE
    size_t write_bytes = offset == 0U && got > 1 ? 1U : (size_t)got;
#else
    size_t write_bytes = (size_t)got;
#endif
    size_t wrote_total = 0U;
    while (wrote_total < write_bytes) {
      ssize_t wrote = write(leaf_fd, buffer + wrote_total, write_bytes - wrote_total);
      if (wrote <= 0) return false;
      wrote_total += (size_t)wrote;
    }
#ifdef WRITCRAFT_TEST_PARTIAL_WRITE
    _exit(91);
#endif
    offset += (uint64_t)got;
  }
  return true;
}

static bool output_result(const Request *request, const char *state, const char *error) {
  if (create_journal_capture) {
    (void)request;
    (void)error;
    if (strlen(state) >= sizeof(create_journal_captured_state)) return false;
    memcpy(create_journal_captured_state, state, strlen(state) + 1U);
    return true;
  }
  char header[1024];
  size_t count = strcmp(state, "COMMITTED") == 0 ? request->count : 0U;
  int length = snprintf(header, sizeof(header), "%c\tRESULT\t%s\t%s\t%s\t%s\t%s\t%zu\t%s\n",
    request->command, state, request->operation, request->artifact, request->phase,
    request->selection, count, error);
  if (length <= 0 || (size_t)length >= sizeof(header) || !write_line(header)) return false;
  if (count > 0U) {
    for (size_t i = 0U; i < count; i += 1U) {
      const Item *item = &request->items[i];
      char line[1024];
      length = snprintf(line, sizeof(line), "T\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
        item->selected, item->control_name, item->receipt_name, item->control_digest,
        item->created_digest, item->content, item->receipt_digest);
      if (length <= 0 || (size_t)length >= sizeof(line) || !write_line(line)) return false;
    }
  }
  return true;
}

static NameState leaf_state(RootBinding *root, Item *item, const Identity *expected_identity);
static bool create_commit_exact(
  RootBinding *root, Request *request,
  const char (*controls)[MAX_RECORD_BYTES + 1U],
  const char (*receipts)[MAX_RECORD_BYTES + 1U],
  const CreateJournalGuard *guard
);
static bool expected_create_records_absent(RootBinding *root, const Request *request);
static bool create_journal_guard_full(RootBinding *root, const CreateJournalGuard *guard);
static bool create_journal_guard_cheap(RootBinding *root, const CreateJournalGuard *guard);

static bool create_items(RootBinding *root, Request *request, const CreateJournalGuard *guard) {
  if ((guard == NULL && !artifact_valid(request)) ||
      (guard != NULL && !create_journal_guard_cheap(root, guard))) {
    return output_result(request, guard == NULL ? "UNCOMMITTED" : "UNKNOWN",
      guard == NULL ? "-" : "UNKNOWN");
  }
  char (*controls)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*controls));
  char (*receipts)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*receipts));
  if (controls == NULL || receipts == NULL) {
    free(controls);
    free(receipts);
    return output_result(request, "UNCOMMITTED", "-");
  }
  for (size_t i = 0U; i < request->count; i += 1U) {
    if ((guard == NULL && !artifact_segment_valid(&request->items[i])) ||
        !build_names_and_control(request, &request->items[i], controls[i])) {
      free(controls);
      free(receipts);
      return output_result(request, "UNCOMMITTED", "-");
    }
  }
  if (!open_recovery(root, false) ||
      !current_record_namespace_clean(root->recovery_fd, request, controls, NULL, NULL)) {
    free(controls);
    free(receipts);
    return output_result(request, "UNKNOWN", "UNKNOWN");
  }
  size_t controls_written = 0U;
  size_t controls_attempted = 0U;
  size_t failed_control = request->count;
  bool guard_failed = false;
  RecordAttempt failed_attempt;
  memset(&failed_attempt, 0, sizeof(failed_attempt));
  failed_attempt.fd = -1;
  for (; controls_written < request->count; controls_written += 1U) {
    Item *item = &request->items[controls_written];
    if (record_state(root->recovery_fd, item->control_name, controls[controls_written]) != NAME_ABSENT ||
        record_state(root->recovery_fd, item->receipt_name, "") != NAME_ABSENT) break;
    if (guard != NULL && !create_journal_guard_cheap(root, guard)) {
      guard_failed = true;
      break;
    }
#ifdef WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_AFTER_GUARD
    if (guard != NULL && controls_written == 0U &&
        !test_sync_point("create-journal-after-guard")) {
      guard_failed = true;
      break;
    }
    if (guard != NULL && !create_journal_guard_cheap(root, guard)) {
      guard_failed = true;
      break;
    }
#endif
#ifdef WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_SECOND_CONTROL
    if (guard != NULL && controls_written == 1U &&
        !test_sync_point("create-journal-second-control")) {
      guard_failed = true;
      break;
    }
    if (guard != NULL && !create_journal_guard_cheap(root, guard)) {
      guard_failed = true;
      break;
    }
#endif
    controls_attempted = controls_written + 1U;
    if (!write_record(root->recovery_fd, item->control_name, controls[controls_written],
          &item->control_identity, &failed_attempt)) {
      failed_control = controls_written;
      break;
    }
    item->control_identity_bound = true;
    memset(&failed_attempt, 0, sizeof(failed_attempt));
    failed_attempt.fd = -1;
  }
  if (controls_written != request->count) {
    if (guard_failed) {
      if (failed_attempt.fd >= 0) (void)close(failed_attempt.fd);
      bool output = output_result(request, "UNKNOWN", "UNKNOWN");
      free(controls);
      free(receipts);
      return output;
    }
    bool clean = create_journal_capture
      ? failed_attempt.created && failed_attempt.identity_bound
      : true;
#ifdef WRITCRAFT_TEST_PAUSE_CONTROL_FAILURE_BEFORE_CLEANUP
    if (failed_attempt.created &&
        !test_sync_point("control-failure-before-cleanup")) clean = false;
#endif
    if (create_journal_capture && failed_attempt.created && failed_attempt.identity_bound &&
        failed_control < request->count) {
      clean = unlink_attempted_record_owned(
        root->recovery_fd, request->items[failed_control].control_name,
        controls[failed_control], &failed_attempt
      ) && clean;
    }
    if (!create_journal_capture) {
      for (size_t i = 0U; i < controls_attempted; i += 1U) {
        NameState state = record_state(
          root->recovery_fd, request->items[i].control_name, controls[i]
        );
        if (state == NAME_EXACT) {
          const Identity *created_identity = NULL;
          int created_fd = -1;
          if (i == failed_control && failed_attempt.created && failed_attempt.identity_bound) {
            created_identity = &failed_attempt.identity;
            created_fd = failed_attempt.fd;
          } else if (request->items[i].control_identity_bound) {
            created_identity = &request->items[i].control_identity;
          }
          clean = created_identity != NULL && unlink_exact_record_owned(
            root->recovery_fd, request->items[i].control_name, controls[i],
            created_identity, created_fd
          ) && clean;
        } else {
          clean = false;
        }
      }
    } else {
      for (size_t i = 0U; i < controls_written; i += 1U) {
        clean = request->items[i].control_identity_bound && unlink_exact_record_owned(
          root->recovery_fd, request->items[i].control_name, controls[i],
          &request->items[i].control_identity, -1
        ) && clean;
      }
    }
    if (failed_attempt.fd >= 0) (void)close(failed_attempt.fd);
    clean = current_record_namespace_clean(
      root->recovery_fd, request, controls, NULL, NULL
    ) && expected_create_records_absent(root, request) && clean;
    bool output = output_result(
      request, clean && !guard_failed ? "UNCOMMITTED" : "UNKNOWN",
      clean && !guard_failed ? "-" : "UNKNOWN"
    );
    free(controls);
    free(receipts);
    return output;
  }
#ifdef WRITCRAFT_TEST_CRASH_PRE_EXCL
  _exit(90);
#endif
  for (size_t i = 0U; i < request->count; i += 1U) {
    Item *item = &request->items[i];
    Ancestor ancestors[MAX_ROOT_COMPONENTS];
    memset(ancestors, 0, sizeof(ancestors));
    for (size_t x = 0U; x < MAX_ROOT_COMPONENTS; x += 1U) ancestors[x].fd = -1;
    size_t depth = 0U;
    int parent = -1;
    char leaf[MAX_PATH_BYTES + 1U];
    char ancestor_digest[72];
    if (!open_parent(root, item->path, ancestors, &depth, &parent, leaf, ancestor_digest) ||
        strcmp(ancestor_digest, item->ancestor) != 0 || !revalidate_parent(root, ancestors, depth)) {
      close_parent(ancestors, depth, parent);
      bool output = output_result(request, "UNKNOWN", "UNKNOWN");
      free(controls);
      free(receipts);
      return output;
    }
    if (guard != NULL && !create_journal_guard_cheap(root, guard)) {
      close_parent(ancestors, depth, parent);
      bool output = output_result(request, "UNKNOWN", "UNKNOWN");
      free(controls);
      free(receipts);
      return output;
    }
#ifdef WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_SECOND_LEAF
    if (guard != NULL && i == 1U && !test_sync_point("create-journal-second-leaf")) {
      close_parent(ancestors, depth, parent);
      bool output = output_result(request, "UNKNOWN", "UNKNOWN");
      free(controls);
      free(receipts);
      return output;
    }
    if (guard != NULL && !create_journal_guard_cheap(root, guard)) {
      close_parent(ancestors, depth, parent);
      bool output = output_result(request, "UNKNOWN", "UNKNOWN");
      free(controls);
      free(receipts);
      return output;
    }
#endif
#ifdef WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_AFTER_LEAF_GUARD
    if (guard != NULL && i == 0U &&
        !test_sync_point("create-journal-after-leaf-guard")) {
      close_parent(ancestors, depth, parent);
      bool output = output_result(request, "UNKNOWN", "UNKNOWN");
      free(controls);
      free(receipts);
      return output;
    }
#endif
    if (guard != NULL && !artifact_segment_valid(item)) {
      close_parent(ancestors, depth, parent);
      bool output = output_result(request, "UNKNOWN", "UNKNOWN");
      free(controls);
      free(receipts);
      return output;
    }
    int leaf_fd = openat(parent, leaf, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0644);
    if (leaf_fd < 0) {
      close_parent(ancestors, depth, parent);
      bool output = output_result(request, "UNKNOWN", "UNKNOWN");
      free(controls);
      free(receipts);
      return output;
    }
    (void)fchmod(leaf_fd, 0644);
#ifdef WRITCRAFT_TEST_CRASH_POST_EXCL
    _exit(92);
#endif
    bool valid = write_artifact_segment(leaf_fd, item);
#ifdef WRITCRAFT_TEST_CRASH_FILE_FSYNC
    _exit(93);
#endif
    valid = valid && fsync(leaf_fd) == 0;
#ifdef WRITCRAFT_TEST_CRASH_AFTER_FILE_FSYNC
    if (valid) _exit(98);
#endif
    Identity created;
    char content[72];
    valid = valid && hash_fd(leaf_fd, &created, content, item->length) &&
      created.nlink == 1U && created.size == item->length && strcmp(content, item->content) == 0;
    if (valid) {
      item->created_identity = created;
      item->created_identity_bound = true;
    }
    struct stat path_stat;
    Identity at_path;
    valid = valid && fstatat(parent, leaf, &path_stat, AT_SYMLINK_NOFOLLOW) == 0 &&
      identity_from_stat(&path_stat, &at_path) && same_file(&created, &at_path);
    (void)close(leaf_fd);
#ifdef WRITCRAFT_TEST_CRASH_PARENT_FSYNC
    _exit(94);
#endif
    valid = valid && fsync(parent) == 0;
#ifdef WRITCRAFT_TEST_CRASH_AFTER_PARENT_FSYNC
    if (valid) _exit(99);
#endif
    valid = valid && revalidate_parent(root, ancestors, depth) &&
      create_identity_digest(&created, item->ancestor, leaf, item->content, item->created_digest);
    close_parent(ancestors, depth, parent);
#ifdef WRITCRAFT_TEST_PAUSE_CREATE_AFTER_PARENT_FSYNC
    if (i == 0U && valid && !test_sync_point("create-after-parent-fsync")) valid = false;
#endif
    valid = valid && (guard != NULL || artifact_segment_valid(item)) && item->created_identity_bound &&
      leaf_state(root, item, &item->created_identity) == NAME_EXACT &&
      build_receipt(request, item, receipts[i]);
    if (!valid) {
      bool output = output_result(request, "UNKNOWN", "UNKNOWN");
      free(controls);
      free(receipts);
      return output;
    }
#ifdef WRITCRAFT_TEST_CRASH_RECEIPT
    _exit(95);
#endif
    if (!write_record(
        root->recovery_fd, item->receipt_name, receipts[i], &item->receipt_identity, NULL
      )) {
      bool output = output_result(request, "UNKNOWN", "UNKNOWN");
      free(controls);
      free(receipts);
      return output;
    }
    item->receipt_identity_bound = true;
#ifdef WRITCRAFT_TEST_CRASH_AFTER_RECEIPT
    _exit(100);
#endif
  }
#ifdef WRITCRAFT_TEST_PAUSE_CREATE_AFTER_RECEIPT
  if (!test_sync_point("create-after-receipt")) {
    bool output = output_result(request, "UNKNOWN", "UNKNOWN");
    free(controls);
    free(receipts);
    return output;
  }
#endif
  if (!create_commit_exact(root, request, controls, receipts, guard)) {
    bool output = output_result(request, "UNKNOWN", "UNKNOWN");
    free(controls);
    free(receipts);
    return output;
  }
#ifdef WRITCRAFT_TEST_DROP_COMMITTED_RESPONSE
  _exit(96);
#endif
  bool output = output_result(request, "COMMITTED", "-");
  free(controls);
  free(receipts);
  return output;
}

static bool parse_receipt_record(
  const Request *request, Item *item, const char *bytes, char rebuilt[MAX_RECORD_BYTES + 1U]
) {
  char copy[MAX_RECORD_BYTES + 1U];
  size_t length = strlen(bytes);
  if (length == 0U || length > MAX_RECORD_BYTES || bytes[length - 1U] != '\n') return false;
  memcpy(copy, bytes, length);
  copy[length - 1U] = '\0';
  char *fields[11];
  size_t count = 0U;
  uint64_t byte_length;
  if (!split_fields(copy, fields, 11U, &count) || count != 11U || strcmp(fields[0], RECEIPT_SCHEMA) != 0 ||
      strcmp(fields[1], request->operation) != 0 || strcmp(fields[2], item->selected) != 0 ||
      strcmp(fields[3], item->control_digest) != 0 || !valid_digest(fields[4]) ||
      strcmp(fields[5], item->content) != 0 || !parse_uint(fields[6], MAX_ARTIFACT_BYTES, &byte_length) ||
      byte_length != item->length || strcmp(fields[7], "1") != 0 || strcmp(fields[8], "1") != 0 ||
      strcmp(fields[9], "1") != 0 || !valid_digest(fields[10])) return false;
  memcpy(item->created_digest, fields[4], DIGEST_BYTES + 1U);
  if (!build_receipt(request, item, rebuilt) || strcmp(fields[10], item->receipt_digest) != 0) return false;
  return strcmp(rebuilt, bytes) == 0;
}

static NameState read_receipt(
  RootBinding *root, const Request *request, Item *item, char rebuilt[MAX_RECORD_BYTES + 1U]
) {
  int fd = openat(root->recovery_fd, item->receipt_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? NAME_ABSENT : NAME_ERROR;
  struct stat stat_value;
  char bytes[MAX_RECORD_BYTES + 1U];
  ssize_t count = pread(fd, bytes, MAX_RECORD_BYTES, 0);
  bool valid = count > 0 && count <= (ssize_t)MAX_RECORD_BYTES && fstat(fd, &stat_value) == 0 &&
    S_ISREG(stat_value.st_mode) && stat_value.st_uid == geteuid() &&
    (stat_value.st_mode & 0777) == 0600 && stat_value.st_nlink == 1;
  (void)close(fd);
  if (!valid) return NAME_FOREIGN;
  bytes[count] = '\0';
  return parse_receipt_record(request, item, bytes, rebuilt) ? NAME_EXACT : NAME_FOREIGN;
}

static NameState leaf_state(RootBinding *root, Item *item, const Identity *expected_identity) {
  Ancestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  for (size_t x = 0U; x < MAX_ROOT_COMPONENTS; x += 1U) ancestors[x].fd = -1;
  size_t depth = 0U;
  int parent = -1;
  char leaf[MAX_PATH_BYTES + 1U];
  char ancestor_digest[72];
  if (!open_parent(root, item->path, ancestors, &depth, &parent, leaf, ancestor_digest) ||
      strcmp(ancestor_digest, item->ancestor) != 0 || !revalidate_parent(root, ancestors, depth)) {
    close_parent(ancestors, depth, parent);
    return NAME_ERROR;
  }
  int fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    NameState state = errno == ENOENT ? NAME_ABSENT : NAME_ERROR;
    close_parent(ancestors, depth, parent);
    return state;
  }
  Identity identity;
  char content[72];
  char created[72];
  bool exact = hash_fd(fd, &identity, content, item->length) && identity.nlink == 1U &&
    strcmp(content, item->content) == 0 &&
    create_identity_digest(&identity, item->ancestor, leaf, item->content, created) &&
    strcmp(created, item->created_digest) == 0 &&
    (expected_identity == NULL || same_file(&identity, expected_identity)) &&
    revalidate_parent(root, ancestors, depth);
  (void)close(fd);
  close_parent(ancestors, depth, parent);
  return exact ? NAME_EXACT : NAME_FOREIGN;
}

static bool create_commit_exact(
  RootBinding *root, Request *request,
  const char (*controls)[MAX_RECORD_BYTES + 1U],
  const char (*receipts)[MAX_RECORD_BYTES + 1U],
  const CreateJournalGuard *guard
) {
  if ((guard == NULL ? !artifact_valid(request) : !create_journal_guard_cheap(root, guard)) ||
      !open_recovery(root, false) ||
      !current_record_namespace_clean(root->recovery_fd, request, controls, NULL, NULL)) return false;
  for (size_t i = 0U; i < request->count; i += 1U) {
    Item *item = &request->items[i];
    if (!item->created_identity_bound || !item->control_identity_bound ||
        !item->receipt_identity_bound || (guard == NULL && !artifact_segment_valid(item)) ||
        !record_identity_matches(root->recovery_fd, item->control_name, controls[i],
          &item->control_identity) ||
        !record_identity_matches(root->recovery_fd, item->receipt_name, receipts[i],
          &item->receipt_identity) ||
        leaf_state(root, item, &item->created_identity) != NAME_EXACT) return false;
  }
  return open_recovery(root, false);
}

static bool request_final_record_absent(int directory, const Request *request) {
  char prefix[512];
  int length = snprintf(prefix, sizeof(prefix), FINAL_ACK_SCHEMA "\t%s\t%s\t%s\t",
    request->operation, request->artifact, request->selection);
  if (length <= 0 || (size_t)length >= sizeof(prefix)) return false;
  int scan_fd = dup(directory);
  if (scan_fd < 0) return false;
  DIR *stream = fdopendir(scan_fd);
  if (stream == NULL) {
    (void)close(scan_fd);
    return false;
  }
  bool absent = true;
  size_t entries = 0U;
  while (true) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (entry == NULL) {
      if (errno != 0) absent = false;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    entries += 1U;
    if (entries > MAX_RECOVERY_ENTRIES) { absent = false; break; }
    if (!has_prefix(entry->d_name, ".changes-history-native-create-final.")) continue;
    char bytes[MAX_RECORD_BYTES + 1U];
    if (read_namespace_record(directory, entry->d_name, bytes) && has_prefix(bytes, prefix)) {
      absent = false;
      break;
    }
  }
  (void)closedir(stream);
  return absent;
}

static bool expected_create_records_absent(RootBinding *root, const Request *request) {
  if (!open_recovery(root, false)) return false;
  for (size_t i = 0U; i < request->count; i += 1U) {
    struct stat ignored;
    if (fstatat(root->recovery_fd, request->items[i].control_name,
          &ignored, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT ||
        fstatat(root->recovery_fd, request->items[i].receipt_name,
          &ignored, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) return false;
  }
  return request_final_record_absent(root->recovery_fd, request) &&
    fsync(root->recovery_fd) == 0 && open_recovery(root, false);
}

static bool reconcile_items(RootBinding *root, Request *request) {
  char (*controls)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*controls));
  char (*receipts)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*receipts));
  if (controls == NULL || receipts == NULL) {
    free(controls);
    free(receipts);
    return output_result(request, "UNKNOWN", "UNKNOWN");
  }
  bool all_absent = true;
  bool all_committed = true;
  for (size_t i = 0U; i < request->count; i += 1U) {
    Item *item = &request->items[i];
    if (!build_names_and_control(request, item, controls[i]) ||
        record_state(root->recovery_fd, item->control_name, controls[i]) != NAME_EXACT) {
      bool output = output_result(request, "UNKNOWN", "UNKNOWN");
      free(controls);
      free(receipts);
      return output;
    }
    NameState receipt = read_receipt(root, request, item, receipts[i]);
    if (receipt == NAME_EXACT) {
      all_absent = false;
      if (leaf_state(root, item, NULL) != NAME_EXACT) all_committed = false;
    } else if (receipt == NAME_ABSENT) {
      all_committed = false;
      item->created_digest[0] = '\0';
      if (leaf_state(root, item, NULL) != NAME_ABSENT) all_absent = false;
    } else {
      bool output = output_result(request, "UNKNOWN", "UNKNOWN");
      free(controls);
      free(receipts);
      return output;
    }
  }
  if (!open_recovery(root, false) ||
      !current_record_namespace_clean(root->recovery_fd, request, controls, NULL, NULL)) {
    bool output = output_result(request, "UNKNOWN", "UNKNOWN");
    free(controls);
    free(receipts);
    return output;
  }
  if (all_committed) {
    bool output = output_result(request, "COMMITTED", "-");
    free(controls);
    free(receipts);
    return output;
  }
  if (!all_absent) {
    bool output = output_result(request, "UNKNOWN", "UNKNOWN");
    free(controls);
    free(receipts);
    return output;
  }
  bool clean = true;
  for (size_t i = 0U; i < request->count; i += 1U) {
    clean = unlink_exact_record(root->recovery_fd, request->items[i].control_name, controls[i]) && clean;
  }
#ifdef WRITCRAFT_TEST_PAUSE_CLEANUP_AFTER_FSYNC
  if (clean && !test_sync_point("cleanup-after-fsync")) clean = false;
#endif
  clean = current_record_namespace_clean(root->recovery_fd, request, controls, NULL, NULL) &&
    expected_create_records_absent(root, request) && clean;
  bool output = output_result(request, clean ? "UNCOMMITTED" : "UNKNOWN", clean ? "-" : "UNKNOWN");
  free(controls);
  free(receipts);
  return output;
}

static bool parse_token_line(char *line, Item *item) {
  char *fields[8];
  size_t count = 0U;
  if (!split_fields(line, fields, 8U, &count) || count != 8U || strcmp(fields[0], "T") != 0 ||
      !valid_selected(fields[1]) || strlen(fields[2]) >= sizeof(item->control_name) ||
      strlen(fields[3]) >= sizeof(item->receipt_name) || !valid_digest(fields[4]) ||
      !valid_digest(fields[5]) || !valid_digest(fields[6]) || !valid_digest(fields[7])) return false;
  memcpy(item->selected, fields[1], strlen(fields[1]) + 1U);
  memcpy(item->control_name, fields[2], strlen(fields[2]) + 1U);
  memcpy(item->receipt_name, fields[3], strlen(fields[3]) + 1U);
  memcpy(item->control_digest, fields[4], DIGEST_BYTES + 1U);
  memcpy(item->created_digest, fields[5], DIGEST_BYTES + 1U);
  memcpy(item->content, fields[6], DIGEST_BYTES + 1U);
  memcpy(item->receipt_digest, fields[7], DIGEST_BYTES + 1U);
  return true;
}

static bool load_control_for_finalize(
  RootBinding *root, const char *operation, const char *artifact, const char *selection, Item *item
) {
  char supplied_control_name[128];
  char supplied_receipt_name[128];
  char supplied_control_digest[72];
  char supplied_created_digest[72];
  char supplied_receipt_digest[72];
  bool control_was_bound = item->control_identity_bound;
  bool receipt_was_bound = item->receipt_identity_bound;
  Identity supplied_control_identity = item->control_identity;
  Identity supplied_receipt_identity = item->receipt_identity;
  memcpy(supplied_control_name, item->control_name, sizeof(supplied_control_name));
  memcpy(supplied_receipt_name, item->receipt_name, sizeof(supplied_receipt_name));
  memcpy(supplied_control_digest, item->control_digest, sizeof(supplied_control_digest));
  memcpy(supplied_created_digest, item->created_digest, sizeof(supplied_created_digest));
  memcpy(supplied_receipt_digest, item->receipt_digest, sizeof(supplied_receipt_digest));
  int fd = openat(root->recovery_fd, supplied_control_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  char bytes[MAX_RECORD_BYTES + 1U];
  ssize_t length = pread(fd, bytes, MAX_RECORD_BYTES, 0);
  struct stat stat_value;
  Identity observed_control_identity;
  bool valid = length > 0 && length <= (ssize_t)MAX_RECORD_BYTES && fstat(fd, &stat_value) == 0 &&
    identity_from_stat(&stat_value, &observed_control_identity) &&
    S_ISREG(stat_value.st_mode) && stat_value.st_uid == geteuid() &&
    (stat_value.st_mode & 0777) == 0600 && stat_value.st_nlink == 1 &&
    record_path_matches_fd(root->recovery_fd, supplied_control_name, fd) &&
    (!control_was_bound || same_file(&supplied_control_identity, &observed_control_identity));
  (void)close(fd);
  if (!valid) { DEBUG_STAGE("control-stat"); return false; }
  bytes[length] = '\0';
  char copy[MAX_RECORD_BYTES + 1U];
  memcpy(copy, bytes, (size_t)length + 1U);
  if (copy[length - 1U] != '\n') return false;
  copy[length - 1U] = '\0';
  char *fields[13];
  size_t count = 0U;
  uint64_t offset;
  uint64_t byte_length;
  if (!split_fields(copy, fields, 13U, &count) || count != 13U) {
    DEBUG_STAGE("control-field-count");
    return false;
  }
  if (strcmp(fields[0], CONTROL_SCHEMA) != 0 || strcmp(fields[1], operation) != 0 ||
      strcmp(fields[2], item->selected) != 0 || strcmp(fields[12], supplied_control_digest) != 0 ||
      strcmp(fields[4], artifact) != 0) {
#ifdef WRITCRAFT_TEST_DEBUG
    (void)fprintf(stderr, "debug:authority:%d:%d:%d:%d:%d\n",
      strcmp(fields[0], CONTROL_SCHEMA), strcmp(fields[1], operation),
      strcmp(fields[2], item->selected), strcmp(fields[12], supplied_control_digest),
      strcmp(fields[4], artifact));
#endif
    DEBUG_STAGE("control-field-authority");
    return false;
  }
  if (!valid_digest(fields[5]) || !valid_digest(fields[6]) || strcmp(fields[7], selection) != 0 ||
      !parse_uint(fields[8], MAX_ARTIFACT_BYTES, &offset) ||
      !parse_uint(fields[9], MAX_ARTIFACT_BYTES, &byte_length) || byte_length == 0U ||
      strcmp(fields[10], item->content) != 0 || !valid_digest(fields[11])) {
    DEBUG_STAGE("control-fields");
    return false;
  }
  Request request;
  memset(&request, 0, sizeof(request));
  memcpy(request.operation, operation, strlen(operation) + 1U);
  memcpy(request.artifact, artifact, DIGEST_BYTES + 1U);
  memcpy(request.artifact_identity, fields[5], DIGEST_BYTES + 1U);
  memcpy(request.phase, fields[6], DIGEST_BYTES + 1U);
  memcpy(request.selection, selection, DIGEST_BYTES + 1U);
  Item rebuilt_item;
  memset(&rebuilt_item, 0, sizeof(rebuilt_item));
  memcpy(rebuilt_item.selected, item->selected, strlen(item->selected) + 1U);
  if (!decode_hex(fields[3], rebuilt_item.path, sizeof(rebuilt_item.path)) ||
      !strict_utf8((const unsigned char *)rebuilt_item.path, strlen(rebuilt_item.path))) {
    DEBUG_STAGE("control-path");
    return false;
  }
  rebuilt_item.offset = offset;
  rebuilt_item.length = byte_length;
  memcpy(rebuilt_item.content, item->content, DIGEST_BYTES + 1U);
  memcpy(rebuilt_item.ancestor, fields[11], DIGEST_BYTES + 1U);
  memcpy(rebuilt_item.created_digest, supplied_created_digest, DIGEST_BYTES + 1U);
  char rebuilt[MAX_RECORD_BYTES + 1U];
  if (!build_names_and_control(&request, &rebuilt_item, rebuilt) || strcmp(rebuilt, bytes) != 0 ||
      strcmp(rebuilt_item.control_name, supplied_control_name) != 0 ||
      strcmp(rebuilt_item.receipt_name, supplied_receipt_name) != 0 ||
      strcmp(rebuilt_item.control_digest, supplied_control_digest) != 0) {
    DEBUG_STAGE("control-rebuild");
    return false;
  }
  char receipt[MAX_RECORD_BYTES + 1U];
  int receipt_fd = -1;
  Identity observed_receipt_identity;
  if (!build_receipt(&request, &rebuilt_item, receipt) ||
      strcmp(rebuilt_item.receipt_digest, supplied_receipt_digest) != 0 ||
      open_record_exact(root->recovery_fd, rebuilt_item.receipt_name, receipt,
        &receipt_fd, &observed_receipt_identity) != NAME_EXACT ||
      !record_path_matches_fd(root->recovery_fd, rebuilt_item.receipt_name, receipt_fd) ||
      (receipt_was_bound && !same_file(&supplied_receipt_identity, &observed_receipt_identity))) {
    if (receipt_fd >= 0) (void)close(receipt_fd);
    DEBUG_STAGE("receipt-rebuild");
    return false;
  }
  (void)close(receipt_fd);
  rebuilt_item.control_identity = observed_control_identity;
  rebuilt_item.receipt_identity = observed_receipt_identity;
  rebuilt_item.control_identity_bound = true;
  rebuilt_item.receipt_identity_bound = true;
  *item = rebuilt_item;
  return true;
}

static bool finalize_records_exact(
  RootBinding *root, const char *operation, const char *artifact,
  const char *selection, Item *items, size_t count
) {
  if (!open_recovery(root, false)) return false;
  for (size_t i = 0U; i < count; i += 1U) {
    if (!load_control_for_finalize(root, operation, artifact, selection, &items[i])) return false;
  }
  return open_recovery(root, false);
}

static bool finalize_namespace_clean(
  int directory, const char *operation, const char *artifact, const char *selection,
  const Item *items, size_t count, const char *final_name, const char *final_record
) {
  int scan_fd = dup(directory);
  if (scan_fd < 0) return false;
  DIR *stream = fdopendir(scan_fd);
  if (stream == NULL) {
    (void)close(scan_fd);
    return false;
  }
  bool clean = true;
  size_t entries = 0U;
  while (true) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (entry == NULL) {
      if (errno != 0) clean = false;
      break;
    }
    const char *name = entry->d_name;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
    entries += 1U;
    if (entries > MAX_RECOVERY_ENTRIES) { clean = false; break; }
    bool native_create = has_prefix(name, ".changes-history-native-create-control.") ||
      has_prefix(name, ".changes-history-native-create-receipt.") ||
      has_prefix(name, ".changes-history-native-create-final.");
    if (!native_create) continue;
    bool expected_name = strcmp(name, final_name) == 0;
    for (size_t i = 0U; i < count && !expected_name; i += 1U) {
      expected_name = strcmp(name, items[i].control_name) == 0 ||
        strcmp(name, items[i].receipt_name) == 0;
    }
    if (expected_name) continue;
    char bytes[MAX_RECORD_BYTES + 1U];
    if (!read_namespace_record(directory, name, bytes)) continue;
    if (strcmp(bytes, final_record) == 0) { clean = false; break; }
    char prefix[512];
    int length = snprintf(prefix, sizeof(prefix), FINAL_ACK_SCHEMA "\t%s\t%s\t%s\t",
      operation, artifact, selection);
    if (length <= 0 || (size_t)length >= sizeof(prefix) || has_prefix(bytes, prefix)) {
      clean = false;
      break;
    }
    for (size_t i = 0U; i < count; i += 1U) {
      length = snprintf(prefix, sizeof(prefix), CONTROL_SCHEMA "\t%s\t%s\t",
        operation, items[i].selected);
      if (length <= 0 || (size_t)length >= sizeof(prefix) || has_prefix(bytes, prefix)) {
        clean = false;
        break;
      }
      length = snprintf(prefix, sizeof(prefix), RECEIPT_SCHEMA "\t%s\t%s\t%s\t",
        operation, items[i].selected, items[i].control_digest);
      if (length <= 0 || (size_t)length >= sizeof(prefix) || has_prefix(bytes, prefix)) {
        clean = false;
        break;
      }
    }
    if (!clean) break;
  }
  (void)closedir(stream);
  return clean;
}

static bool finalize_items(
  RootBinding *root, const char *operation, const char *artifact, const char *selection,
  const char *history_phase, const char *expected_set, Item *items, size_t count
) {
  char *canonical = malloc(512U + (count * 512U));
  if (canonical == NULL) return false;
  size_t capacity = 512U + (count * 512U);
  int wrote = snprintf(canonical, capacity, "{\"artifactDigest\":\"%s\",\"items\":[", artifact);
  bool valid = wrote > 0 && (size_t)wrote < capacity;
  size_t used = valid ? (size_t)wrote : 0U;
  for (size_t i = 0U; valid && i < count; i += 1U) {
    Item *item = &items[i];
    if (!load_control_for_finalize(root, operation, artifact, selection, item)) {
      DEBUG_STAGE("load-control");
      valid = false;
      break;
    }
    wrote = snprintf(canonical + used, capacity - used,
      "%s{\"controlDigest\":\"%s\",\"createdIdentityDigest\":\"%s\",\"receiptDigest\":\"%s\""
      ",\"selectedId\":\"%s\"}", i == 0U ? "" : ",", item->control_digest,
      item->created_digest, item->receipt_digest, item->selected);
    valid = wrote > 0 && (size_t)wrote < capacity - used;
    if (valid) used += (size_t)wrote;
  }
  if (valid) {
    wrote = snprintf(canonical + used, capacity - used,
      "],\"operationId\":\"%s\",\"schema\":\"" RECEIPT_SET_SCHEMA "\",\"selectionDigest\":\"%s\"}",
      operation, selection);
    valid = wrote > 0 && (size_t)wrote < capacity - used;
  }
  char set_digest[72];
  valid = valid && digest_domain(RECEIPT_SET_SCHEMA, canonical, set_digest) &&
    strcmp(set_digest, expected_set) == 0;
  free(canonical);
  if (!valid) { DEBUG_STAGE("receipt-set"); return false; }
  char key[1024];
  wrote = snprintf(key, sizeof(key),
    "{\"artifactDigest\":\"%s\",\"historyCommittedPhaseDigest\":\"%s\",\"operationId\":\"%s\""
    ",\"receiptSetDigest\":\"%s\",\"schema\":\"" FINAL_KEY_SCHEMA "\",\"selectionDigest\":\"%s\"}",
    artifact, history_phase, operation, set_digest, selection);
  char key_digest[72];
  if (wrote <= 0 || (size_t)wrote >= sizeof(key) || !digest_domain(FINAL_KEY_SCHEMA, key, key_digest)) {
    DEBUG_STAGE("final-key");
    return false;
  }
  char final_name[128];
  wrote = snprintf(final_name, sizeof(final_name), ".changes-history-native-create-final.%s", key_digest + 7U);
  if (wrote <= 0 || (size_t)wrote >= sizeof(final_name)) return false;
  char ack_canonical[2048];
  wrote = snprintf(ack_canonical, sizeof(ack_canonical),
    "{\"artifactDigest\":\"%s\",\"historyCommittedPhaseDigest\":\"%s\",\"itemCount\":%zu"
    ",\"operationId\":\"%s\",\"receiptSetDigest\":\"%s\",\"recoveryFsyncComplete\":true"
    ",\"schema\":\"" FINAL_ACK_SCHEMA "\",\"selectionDigest\":\"%s\"}",
    artifact, history_phase, count, operation, set_digest, selection);
  char ack_digest[72];
  if (wrote <= 0 || (size_t)wrote >= sizeof(ack_canonical) ||
      !digest_domain(FINAL_ACK_SCHEMA, ack_canonical, ack_digest)) {
    DEBUG_STAGE("final-ack");
    return false;
  }
  char record[4097];
  wrote = snprintf(record, sizeof(record), FINAL_ACK_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%zu\t1\t%s\n",
    operation, artifact, selection, history_phase, set_digest, count, ack_digest);
  if (wrote <= 0 || (size_t)wrote >= sizeof(record)) return false;
  if (!open_recovery(root, false) ||
      !finalize_namespace_clean(root->recovery_fd, operation, artifact, selection,
        items, count, final_name, record)) {
    DEBUG_STAGE("final-namespace-before");
    return false;
  }
#ifdef WRITCRAFT_TEST_PAUSE_FINALIZE_AFTER_RECORDS
  if (!test_sync_point("finalize-after-records")) return false;
#endif
  if (!finalize_records_exact(root, operation, artifact, selection, items, count)) {
    DEBUG_STAGE("final-record-authority-before");
    return false;
  }
  int final_fd = -1;
  Identity final_identity;
  NameState state = open_record_exact(
    root->recovery_fd, final_name, record, &final_fd, &final_identity
  );
  if (final_fd >= 0) (void)close(final_fd);
  if (!(state == NAME_EXACT ||
      (state == NAME_ABSENT && write_record(
        root->recovery_fd, final_name, record, &final_identity, NULL)))) {
    DEBUG_STAGE("final-record");
    return false;
  }
#ifdef WRITCRAFT_TEST_PAUSE_FINALIZE_AFTER_ACK
  if (!test_sync_point("finalize-after-ack")) return false;
#endif
  if (!open_recovery(root, false) ||
      !finalize_namespace_clean(root->recovery_fd, operation, artifact, selection,
        items, count, final_name, record) ||
      !finalize_records_exact(root, operation, artifact, selection, items, count) ||
      !record_identity_matches(root->recovery_fd, final_name, record, &final_identity) ||
      !open_recovery(root, false)) {
    DEBUG_STAGE("final-namespace-after");
    return false;
  }
#ifdef WRITCRAFT_TEST_DROP_FINAL_RESPONSE
  if (state == NAME_ABSENT) _exit(97);
#endif
  char line[1024];
  wrote = snprintf(line, sizeof(line), "F\tOK\tACKED\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
    operation, artifact, selection, history_phase, set_digest, final_name, ack_digest);
  return wrote > 0 && (size_t)wrote < sizeof(line) && write_line(line);
}

static bool parse_identity_fields(
  char **fields, size_t start, RecordIdentity *out
) {
  uint64_t dev, ino, uid, mode, nlink, size, mtime, ctime;
  if (!parse_uint(fields[start], UINT64_MAX, &dev) ||
      !parse_uint(fields[start + 1U], UINT64_MAX, &ino) ||
      !parse_uint(fields[start + 2U], UINT64_MAX, &uid) ||
      !parse_uint(fields[start + 3U], UINT64_MAX, &mode) ||
      !parse_uint(fields[start + 4U], UINT64_MAX, &nlink) ||
      !parse_uint(fields[start + 5U], UINT64_MAX, &size) ||
      !parse_uint(fields[start + 6U], INTMAX_MAX, &mtime) ||
      !parse_uint(fields[start + 7U], INTMAX_MAX, &ctime) ||
      !valid_digest(fields[start + 8U]) || uid != (uint64_t)geteuid() ||
      mode != 0600U || nlink != 1U) return false;
  out->identity.dev = (uintmax_t)dev;
  out->identity.ino = (uintmax_t)ino;
  out->identity.uid = (uintmax_t)uid;
  out->identity.mode = (uintmax_t)(S_IFREG | mode);
  out->identity.nlink = (uintmax_t)nlink;
  out->identity.size = (uintmax_t)size;
  out->identity.mtime_ns = (intmax_t)mtime;
  out->identity.ctime_ns = (intmax_t)ctime;
  memcpy(out->content, fields[start + 8U], DIGEST_BYTES + 1U);
  return true;
}

static bool append_identity(
  char *line, size_t capacity, size_t *used, const RecordIdentity *record
);

static bool valid_digest_basename(const char *value, const char *prefix) {
  size_t prefix_length = strlen(prefix);
  if (value == NULL || strlen(value) != prefix_length + 64U ||
      strncmp(value, prefix, prefix_length) != 0) return false;
  for (const char *c = value + prefix_length; *c != '\0'; c += 1U) {
    if (!((*c >= '0' && *c <= '9') || (*c >= 'a' && *c <= 'f'))) return false;
  }
  return true;
}

static bool create_cleanup_header(char *line, CreateCleanupRequest *request) {
  char *fields[19];
  size_t count = 0U;
  uint64_t item_count;
  if (!split_fields(line, fields, 19U, &count) || count != 19U ||
      !((strcmp(fields[0], "G") == 0) || (strcmp(fields[0], "R") == 0) ||
        (strcmp(fields[0], "A") == 0)) || strcmp(fields[1], "CREATE_CLEANUP") != 0 ||
      !valid_operation(fields[2]) || !valid_digest(fields[3]) ||
      !valid_digest(fields[4]) || !valid_digest(fields[5]) || !valid_digest(fields[6]) ||
      !valid_digest_basename(fields[7], ".changes-history-native-create-final.") ||
      !parse_identity_fields(fields, 8U, &request->final_record) ||
      !valid_digest(fields[17]) ||
      !parse_uint(fields[18], MAX_ITEMS * 2U, &item_count) || item_count < 2U ||
      (item_count % 2U) != 0U) return false;
  request->command = fields[0][0];
  memcpy(request->operation, fields[2], strlen(fields[2]) + 1U);
  memcpy(request->create_request, fields[3], DIGEST_BYTES + 1U);
  memcpy(request->committed_publication, fields[4], DIGEST_BYTES + 1U);
  memcpy(request->finalize_request, fields[5], DIGEST_BYTES + 1U);
  memcpy(request->final_ack, fields[6], DIGEST_BYTES + 1U);
  memcpy(request->final_name, fields[7], strlen(fields[7]) + 1U);
  memcpy(request->authority_digest, fields[17], DIGEST_BYTES + 1U);
  request->count = (size_t)item_count;
  return true;
}

static bool create_cleanup_item_line(
  char *line, CreateCleanupRequest *request, size_t index
) {
  char *fields[17];
  size_t count = 0U;
  uint64_t ordinal;
  CreateCleanupItem *item = &request->items[index];
  if (!split_fields(line, fields, 17U, &count) || count != 17U ||
      strcmp(fields[0], "K") != 0 || !parse_uint(fields[1], MAX_ITEMS * 2U - 1U, &ordinal) ||
      ordinal != index || !valid_selected(fields[2]) ||
      !((index % 2U == 0U && strcmp(fields[3], "CONTROL") == 0 &&
        valid_digest_basename(fields[4], ".changes-history-native-create-control.")) ||
        (index % 2U == 1U && strcmp(fields[3], "RECEIPT") == 0 &&
        valid_digest_basename(fields[4], ".changes-history-native-create-receipt."))) ||
      !valid_digest_basename(fields[5], ".changes-history-native-create-cleanup.") ||
      !valid_digest(fields[6]) || !valid_digest(fields[7]) ||
      !parse_identity_fields(fields, 8U, &item->record) ||
      strcmp(item->record.content, fields[6]) != 0) return false;
  item->ordinal = index;
  memcpy(item->selected, fields[2], strlen(fields[2]) + 1U);
  memcpy(item->role, fields[3], strlen(fields[3]) + 1U);
  memcpy(item->source_name, fields[4], strlen(fields[4]) + 1U);
  memcpy(item->cleanup_name, fields[5], strlen(fields[5]) + 1U);
  memcpy(item->record_digest, fields[6], DIGEST_BYTES + 1U);
  memcpy(item->item_digest, fields[7], DIGEST_BYTES + 1U);
  if ((index % 2U == 1U && strcmp(request->items[index - 1U].selected, item->selected) != 0)) {
    return false;
  }
  for (size_t i = 0U; i < index; i += 1U) {
    CreateCleanupItem *other = &request->items[i];
    if (strcmp(other->source_name, item->source_name) == 0 ||
        strcmp(other->cleanup_name, item->cleanup_name) == 0 ||
        strcmp(other->source_name, item->cleanup_name) == 0 ||
        strcmp(other->cleanup_name, item->source_name) == 0) return false;
  }
  return strcmp(item->source_name, item->cleanup_name) != 0;
}

static NameState create_cleanup_record_state(
  int directory, const char *name, const CreateCleanupItem *item,
  bool moved, RecordIdentity *observed
) {
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? NAME_ABSENT : NAME_ERROR;
  Identity identity;
  char content[DIGEST_BYTES + 1U];
  bool exact = hash_fd(fd, &identity, content, MAX_RECORD_BYTES) &&
    record_path_matches_fd(directory, name, fd) &&
    strcmp(content, item->record_digest) == 0 &&
    (moved ? same_bound_record(&identity, &item->record.identity)
      : same_file(&identity, &item->record.identity));
  (void)close(fd);
  if (!exact) return NAME_FOREIGN;
  if (observed != NULL) {
    observed->identity = identity;
    memcpy(observed->content, content, DIGEST_BYTES + 1U);
  }
  return NAME_EXACT;
}

static bool create_cleanup_final_record_exact(
  RootBinding *root, const CreateCleanupRequest *request
) {
  int fd = openat(
    root->recovery_fd,
    request->final_name,
    O_RDONLY | O_NOFOLLOW | O_CLOEXEC
  );
  if (fd < 0) return false;
  Identity identity;
  char content[DIGEST_BYTES + 1U];
  bool exact = hash_fd(fd, &identity, content, MAX_RECORD_BYTES) &&
    same_file(&identity, &request->final_record.identity) &&
    strcmp(content, request->final_record.content) == 0 &&
    record_path_matches_fd(root->recovery_fd, request->final_name, fd);
  (void)close(fd);
  return exact;
}

typedef enum {
  CREATE_CLEANUP_UNKNOWN = -1,
  CREATE_CLEANUP_UNCOMMITTED = 0,
  CREATE_CLEANUP_COMMITTED = 1,
  CREATE_CLEANUP_ACKED = 2,
} CreateCleanupState;

static CreateCleanupState create_cleanup_state(
  RootBinding *root, CreateCleanupRequest *request, RecordIdentity *moved
) {
  bool uncommitted = true;
  bool committed = true;
  bool acked = true;
  for (size_t i = 0U; i < request->count; i += 1U) {
    CreateCleanupItem *item = &request->items[i];
    NameState source = create_cleanup_record_state(
      root->recovery_fd, item->source_name, item, false, NULL
    );
    NameState cleanup = create_cleanup_record_state(
      root->recovery_fd, item->cleanup_name, item, true, &moved[i]
    );
    if (source == NAME_FOREIGN || source == NAME_ERROR ||
        cleanup == NAME_FOREIGN || cleanup == NAME_ERROR) return CREATE_CLEANUP_UNKNOWN;
    uncommitted = uncommitted && source == NAME_EXACT && cleanup == NAME_ABSENT;
    committed = committed && source == NAME_ABSENT && cleanup == NAME_EXACT;
    acked = acked && source == NAME_ABSENT && cleanup == NAME_ABSENT;
  }
  if (uncommitted) return CREATE_CLEANUP_UNCOMMITTED;
  if (committed) return CREATE_CLEANUP_COMMITTED;
  if (acked) return CREATE_CLEANUP_ACKED;
  return CREATE_CLEANUP_UNKNOWN;
}

static bool output_create_cleanup(
  CreateCleanupRequest *request, const char *state, const char *error,
  RecordIdentity *moved
) {
  size_t count = strcmp(state, "COMMITTED") == 0 ? request->count : 0U;
  char letter = request->command;
  char line[2048];
  int length = snprintf(line, sizeof(line), "%c\tOK\t%s\t%s\t%s\t%zu\t%s\n",
    letter, state, request->operation, request->authority_digest, count, error);
  if (length <= 0 || (size_t)length >= sizeof(line) || !write_line(line)) return false;
  for (size_t i = 0U; i < count; i += 1U) {
    size_t used = 0U;
    length = snprintf(line, sizeof(line), "K\t%zu\t%s", i, request->items[i].cleanup_name);
    if (length <= 0 || (size_t)length >= sizeof(line)) return false;
    used = (size_t)length;
    if (!append_identity(line, sizeof(line), &used, &moved[i]) || used + 2U > sizeof(line)) {
      return false;
    }
    line[used++] = '\n';
    line[used] = '\0';
    if (!write_line(line)) return false;
  }
  return true;
}

static bool move_create_cleanup_item(RootBinding *root, CreateCleanupItem *item) {
  int fd = openat(root->recovery_fd, item->source_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  Identity before;
  char content[DIGEST_BYTES + 1U];
  struct stat ignored;
  bool exact = hash_fd(fd, &before, content, MAX_RECORD_BYTES) &&
    same_file(&before, &item->record.identity) && strcmp(content, item->record_digest) == 0 &&
    record_path_matches_fd(root->recovery_fd, item->source_name, fd) &&
    fstatat(root->recovery_fd, item->cleanup_name, &ignored, AT_SYMLINK_NOFOLLOW) != 0 &&
    errno == ENOENT && renameatx_np(root->recovery_fd, item->source_name,
      root->recovery_fd, item->cleanup_name, RENAME_EXCL) == 0;
  Identity after;
  char after_content[DIGEST_BYTES + 1U];
  exact = exact && hash_fd(fd, &after, after_content, MAX_RECORD_BYTES) &&
    same_bound_record(&before, &after) && strcmp(after_content, item->record_digest) == 0 &&
    record_path_matches_fd(root->recovery_fd, item->cleanup_name, fd) &&
    fstatat(root->recovery_fd, item->source_name, &ignored, AT_SYMLINK_NOFOLLOW) != 0 &&
    errno == ENOENT;
  (void)close(fd);
  return exact;
}

static bool ack_create_cleanup_item(RootBinding *root, CreateCleanupItem *item) {
  int fd = openat(root->recovery_fd, item->cleanup_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT;
  Identity identity;
  char content[DIGEST_BYTES + 1U];
  struct stat ignored;
  bool exact = hash_fd(fd, &identity, content, MAX_RECORD_BYTES) &&
    same_bound_record(&identity, &item->record.identity) &&
    strcmp(content, item->record_digest) == 0 &&
    record_path_matches_fd(root->recovery_fd, item->cleanup_name, fd) &&
    unlinkat(root->recovery_fd, item->cleanup_name, 0) == 0 &&
    fstatat(root->recovery_fd, item->cleanup_name, &ignored, AT_SYMLINK_NOFOLLOW) != 0 &&
    errno == ENOENT;
  (void)close(fd);
  return exact;
}

static bool run_create_cleanup(RootBinding *root, CreateCleanupRequest *request) {
  RecordIdentity moved[MAX_ITEMS * 2U];
  memset(moved, 0, sizeof(moved));
  if (!create_cleanup_final_record_exact(root, request)) {
    return output_create_cleanup(request, "UNKNOWN", "UNKNOWN", moved);
  }
  CreateCleanupState state = create_cleanup_state(root, request, moved);
  if (request->command == 'R') {
    return output_create_cleanup(request,
      state == CREATE_CLEANUP_COMMITTED ? "COMMITTED" :
        state == CREATE_CLEANUP_UNCOMMITTED ? "UNCOMMITTED" : "UNKNOWN",
      state == CREATE_CLEANUP_UNKNOWN || state == CREATE_CLEANUP_ACKED ? "UNKNOWN" : "-",
      moved);
  }
  if (request->command == 'G') {
    if (state == CREATE_CLEANUP_UNCOMMITTED) {
      bool moved_all = true;
      for (size_t i = 0U; i < request->count; i += 1U) {
        moved_all = create_cleanup_final_record_exact(root, request) &&
          move_create_cleanup_item(root, &request->items[i]) && moved_all;
        if (!moved_all) break;
      }
      if (moved_all) moved_all = fsync(root->recovery_fd) == 0 && open_recovery(root, false);
#ifdef WRITCRAFT_TEST_PAUSE_CREATE_CLEANUP_AFTER_G_FSYNC
      if (moved_all && !test_sync_point("create-cleanup-after-g-fsync")) moved_all = false;
#endif
      if (moved_all) moved_all = create_cleanup_final_record_exact(root, request);
      state = moved_all ? create_cleanup_state(root, request, moved) : CREATE_CLEANUP_UNKNOWN;
    }
    return output_create_cleanup(request,
      state == CREATE_CLEANUP_COMMITTED ? "COMMITTED" :
        state == CREATE_CLEANUP_UNCOMMITTED ? "UNCOMMITTED" : "UNKNOWN",
      state == CREATE_CLEANUP_UNKNOWN || state == CREATE_CLEANUP_ACKED ? "UNKNOWN" : "-",
      moved);
  }
  if (state != CREATE_CLEANUP_COMMITTED && state != CREATE_CLEANUP_ACKED) {
    return output_create_cleanup(request, "UNKNOWN", "UNKNOWN", moved);
  }
  bool acked = true;
  for (size_t i = 0U; i < request->count; i += 1U) {
    NameState source = create_cleanup_record_state(
      root->recovery_fd, request->items[i].source_name, &request->items[i], false, NULL
    );
    acked = create_cleanup_final_record_exact(root, request) &&
      source == NAME_ABSENT &&
      ack_create_cleanup_item(root, &request->items[i]) && acked;
    if (!acked) break;
  }
  if (acked) acked = fsync(root->recovery_fd) == 0 && open_recovery(root, false) &&
    create_cleanup_state(root, request, moved) == CREATE_CLEANUP_ACKED;
#ifdef WRITCRAFT_TEST_PAUSE_CREATE_CLEANUP_AFTER_A_FSYNC
  if (acked && !test_sync_point("create-cleanup-after-a-fsync")) acked = false;
#endif
  if (acked) acked = create_cleanup_final_record_exact(root, request);
  return output_create_cleanup(request, acked ? "ACKED" : "UNKNOWN",
    acked ? "-" : "UNKNOWN", moved);
}

static bool record_identity_exact(
  int directory, const char *name, const char *bytes, const RecordIdentity *expected
) {
  char content[72];
  sha256_prefixed((const unsigned char *)bytes, strlen(bytes), content);
  return strcmp(content, expected->content) == 0 &&
    record_identity_matches(directory, name, bytes, &expected->identity);
}

static bool record_identity_describes_bytes(const RecordIdentity *identity, const char *bytes) {
  char content[72];
  sha256_prefixed((const unsigned char *)bytes, strlen(bytes), content);
  return identity->identity.uid == (uintmax_t)geteuid() &&
    permission_mode(identity->identity.mode) == 0600U && identity->identity.nlink == 1U &&
    identity->identity.size == strlen(bytes) && strcmp(identity->content, content) == 0;
}

static bool append_identity(char *line, size_t capacity, size_t *used, const RecordIdentity *record) {
  int length = snprintf(line + *used, capacity - *used,
    "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX
    "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%s",
    record->identity.dev, record->identity.ino, record->identity.uid,
    permission_mode(record->identity.mode), record->identity.nlink, record->identity.size,
    (uintmax_t)record->identity.mtime_ns, (uintmax_t)record->identity.ctime_ns,
    record->content);
  if (length <= 0 || (size_t)length >= capacity - *used) return false;
  *used += (size_t)length;
  return true;
}

static bool capture_record_identity(
  int directory, const char *name, const char *bytes, RecordIdentity *out
) {
  int fd = -1;
  Identity identity;
  if (open_record_exact(directory, name, bytes, &fd, &identity) != NAME_EXACT ||
      !record_path_matches_fd(directory, name, fd)) {
    if (fd >= 0) (void)close(fd);
    return false;
  }
  (void)close(fd);
  out->identity = identity;
  sha256_prefixed((const unsigned char *)bytes, strlen(bytes), out->content);
  return true;
}

static bool undo_header(char *line, UndoRequest *request) {
  char *fields[14];
  size_t count = 0U;
  uint64_t item_count;
  if (!split_fields(line, fields, 14U, &count) || count != 12U ||
      !(strcmp(fields[0], "Q") == 0 || strcmp(fields[0], "R") == 0) ||
      strcmp(fields[1], "UNDO") != 0 || !valid_operation(fields[2]) ||
      !valid_digest(fields[3]) || !valid_digest(fields[4]) ||
      !parse_uint(fields[5], MAX_ARTIFACT_BYTES, &request->artifact_length) ||
      request->artifact_length == 0U || !valid_digest(fields[6]) ||
      !valid_digest(fields[7]) || !valid_digest(fields[8]) ||
      !valid_digest(fields[9]) || !valid_digest(fields[10]) ||
      !parse_uint(fields[11], MAX_ITEMS, &item_count) || item_count == 0U) return false;
  request->command = fields[0][0];
  memcpy(request->operation, fields[2], strlen(fields[2]) + 1U);
  memcpy(request->artifact, fields[3], DIGEST_BYTES + 1U);
  memcpy(request->artifact_identity, fields[4], DIGEST_BYTES + 1U);
  memcpy(request->root_digest, fields[6], DIGEST_BYTES + 1U);
  memcpy(request->recovery_digest, fields[7], DIGEST_BYTES + 1U);
  memcpy(request->phase, fields[8], DIGEST_BYTES + 1U);
  memcpy(request->selection, fields[9], DIGEST_BYTES + 1U);
  memcpy(request->prepared_history, fields[10], DIGEST_BYTES + 1U);
  request->count = (size_t)item_count;
  return true;
}

static bool undo_item_line(char *line, UndoRequest *request, size_t index) {
  char *fields[8];
  size_t count = 0U;
  UndoItem *item = &request->items[index];
  if (!split_fields(line, fields, 8U, &count) || count != 7U || strcmp(fields[0], "J") != 0 ||
      !valid_selected(fields[1]) || !decode_hex(fields[2], item->path, sizeof(item->path)) ||
      !strict_utf8((const unsigned char *)item->path, strlen(item->path)) ||
      !valid_public_path(item->path) ||
      !parse_uint(fields[3], request->artifact_length, &item->length) || item->length == 0U ||
      !valid_digest(fields[4]) || !valid_digest(fields[5]) || !valid_digest(fields[6])) return false;
  memcpy(item->selected, fields[1], strlen(fields[1]) + 1U);
  memcpy(item->content, fields[4], DIGEST_BYTES + 1U);
  memcpy(item->ancestor, fields[5], DIGEST_BYTES + 1U);
  memcpy(item->created, fields[6], DIGEST_BYTES + 1U);
  for (size_t i = 0U; i < index; i += 1U) {
    if (strcmp(request->items[i].selected, item->selected) == 0 ||
        strcmp(request->items[i].path, item->path) == 0 ||
        strcmp(request->items[i].created, item->created) == 0) return false;
  }
  return true;
}

static bool undo_authority_valid(RootBinding *root, const UndoRequest *undo) {
  if (strcmp(undo->root_digest, root->expected_root) != 0 ||
      strcmp(undo->recovery_digest, root->expected_recovery) != 0) return false;
  Request artifact;
  memset(&artifact, 0, sizeof(artifact));
  artifact.artifact_length = undo->artifact_length;
  memcpy(artifact.artifact, undo->artifact, DIGEST_BYTES + 1U);
  memcpy(artifact.artifact_identity, undo->artifact_identity, DIGEST_BYTES + 1U);
  return artifact_valid(&artifact) && open_recovery(root, false);
}

static bool build_undo_control(
  const UndoRequest *request, UndoItem *item, char out[MAX_RECORD_BYTES + 1U]
) {
  char key[2048];
  int length = snprintf(key, sizeof(key),
    "{\"artifactDigest\":\"%s\",\"createdIdentityDigest\":\"%s\",\"operationId\":\"%s\""
    ",\"precreatePhaseDigest\":\"%s\",\"preparedHistoryDigest\":\"%s\""
    ",\"schema\":\"" UNDO_RECORD_KEY_SCHEMA "\",\"selectedId\":\"%s\""
    ",\"selectionDigest\":\"%s\"}", request->artifact, item->created,
    request->operation, request->phase, request->prepared_history, item->selected,
    request->selection);
  char key_digest[72];
  if (length <= 0 || (size_t)length >= sizeof(key) ||
      !digest_domain(UNDO_RECORD_KEY_SCHEMA, key, key_digest)) return false;
  length = snprintf(item->control_name, sizeof(item->control_name),
    ".changes-history-native-undo-control.%s", key_digest + 7U);
  if (length <= 0 || (size_t)length >= sizeof(item->control_name)) return false;
  length = snprintf(item->receipt_name, sizeof(item->receipt_name),
    ".changes-history-native-undo-receipt.%s", key_digest + 7U);
  if (length <= 0 || (size_t)length >= sizeof(item->receipt_name)) return false;
  char escaped[MAX_PATH_BYTES * 2U + 1U];
  if (!json_escape(item->path, escaped, sizeof(escaped))) return false;
  char canonical[MAX_RECORD_BYTES + 1U];
  length = snprintf(canonical, sizeof(canonical),
    "{\"ancestorIdentityDigest\":\"%s\",\"artifactByteLength\":%" PRIu64
    ",\"artifactDigest\":\"%s\",\"artifactIdentityDigest\":\"%s\",\"byteLength\":%" PRIu64
    ",\"contentDigest\":\"%s\",\"createdIdentityDigest\":\"%s\",\"operationId\":\"%s\""
    ",\"path\":\"%s\",\"precreatePhaseDigest\":\"%s\",\"preparedHistoryDigest\":\"%s\""
    ",\"recoveryIdentityDigest\":\"%s\",\"rootIdentityDigest\":\"%s\""
    ",\"schema\":\"" UNDO_CONTROL_SCHEMA "\",\"selectedId\":\"%s\""
    ",\"selectionDigest\":\"%s\"}", item->ancestor, request->artifact_length,
    request->artifact, request->artifact_identity, item->length, item->content, item->created,
    request->operation, escaped, request->phase, request->prepared_history,
    request->recovery_digest, request->root_digest, item->selected, request->selection);
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(UNDO_CONTROL_SCHEMA, canonical, item->control_digest)) return false;
  char path_hex[(MAX_PATH_BYTES * 2U) + 1U];
  static const char alphabet[] = "0123456789abcdef";
  size_t path_length = strlen(item->path);
  for (size_t i = 0U; i < path_length; i += 1U) {
    unsigned char byte = (unsigned char)item->path[i];
    path_hex[i * 2U] = alphabet[byte >> 4U];
    path_hex[(i * 2U) + 1U] = alphabet[byte & 0x0fU];
  }
  path_hex[path_length * 2U] = '\0';
  length = snprintf(out, MAX_RECORD_BYTES + 1U,
    UNDO_CONTROL_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%" PRIu64 "\t%s\t%s\t%s\t%s\t%s"
    "\t%" PRIu64 "\t%s\t%s\t%s\t%s\n", request->operation, item->selected, path_hex,
    request->artifact, request->artifact_identity, request->artifact_length, request->root_digest,
    request->recovery_digest, request->phase, request->selection, request->prepared_history,
    item->length, item->content, item->ancestor, item->created, item->control_digest);
  return length > 0 && length <= (int)MAX_RECORD_BYTES;
}

static bool build_undo_receipt(
  const UndoRequest *request, UndoItem *item, char out[MAX_RECORD_BYTES + 1U]
) {
  char canonical[4096];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"byteLength\":%" PRIu64 ",\"contentDigest\":\"%s\",\"controlDigest\":\"%s\""
    ",\"createdIdentityDigest\":\"%s\",\"operationId\":\"%s\""
    ",\"publicParentFsyncComplete\":true,\"quarantineBasename\":\"%s\""
    ",\"quarantineIdentityDigest\":\"%s\",\"recoveryFsyncComplete\":true"
    ",\"schema\":\"" UNDO_RECEIPT_SCHEMA "\",\"selectedId\":\"%s\"}",
    item->length, item->content, item->control_digest, item->created, request->operation,
    item->quarantine_name, item->quarantine_digest, item->selected);
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(UNDO_RECEIPT_SCHEMA, canonical, item->receipt_digest)) return false;
  length = snprintf(out, MAX_RECORD_BYTES + 1U,
    UNDO_RECEIPT_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%" PRIu64
    "\t1\t1\t%s\n", request->operation, item->selected, item->control_digest,
    item->quarantine_name, item->created, item->quarantine_digest, item->content,
    item->length, item->receipt_digest);
  return length > 0 && length <= (int)MAX_RECORD_BYTES;
}

static bool random_private_quarantine(const char *prefix, char out[128]) {
  unsigned char random[16];
  static const char alphabet[] = "0123456789abcdef";
  char hex[33];
  arc4random_buf(random, sizeof(random));
  for (size_t i = 0U; i < sizeof(random); i += 1U) {
    hex[i * 2U] = alphabet[random[i] >> 4U];
    hex[(i * 2U) + 1U] = alphabet[random[i] & 0x0fU];
  }
  hex[32] = '\0';
  int length = snprintf(out, 128U, "%s%s", prefix, hex);
  return length > 0 && length < 128;
}

static bool random_undo_quarantine(char out[128]) {
  return random_private_quarantine(".changes-history-native-undo-quarantine.", out);
}

static bool undo_namespace_clean(
  int directory, const UndoRequest *request,
  const char (*controls)[MAX_RECORD_BYTES + 1U],
  const char (*receipts)[MAX_RECORD_BYTES + 1U],
  const char *final_name, const char *final_record
) {
  int scan_fd = dup(directory);
  if (scan_fd < 0) return false;
  DIR *stream = fdopendir(scan_fd);
  if (stream == NULL) { (void)close(scan_fd); return false; }
  bool clean = true;
  size_t entries = 0U;
  while (true) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (entry == NULL) { if (errno != 0) clean = false; break; }
    const char *name = entry->d_name;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
    entries += 1U;
    if (entries > MAX_RECOVERY_ENTRIES) { clean = false; break; }
    bool undo_name = has_prefix(name, ".changes-history-native-undo-control.") ||
      has_prefix(name, ".changes-history-native-undo-receipt.") ||
      has_prefix(name, ".changes-history-native-undo-quarantine.") ||
      has_prefix(name, ".changes-history-native-undo-final.");
    if (!undo_name) continue;
    bool expected = final_name != NULL && strcmp(name, final_name) == 0;
    for (size_t i = 0U; i < request->count && !expected; i += 1U) {
      expected = strcmp(name, request->items[i].control_name) == 0 ||
        strcmp(name, request->items[i].receipt_name) == 0 ||
        (request->items[i].quarantine_name[0] != '\0' &&
          strcmp(name, request->items[i].quarantine_name) == 0);
    }
    if (expected) continue;
    char bytes[MAX_RECORD_BYTES + 1U];
    if (read_namespace_record(directory, name, bytes)) {
      if (final_record != NULL && strcmp(bytes, final_record) == 0) { clean = false; break; }
      char final_prefix[512];
      int final_length = snprintf(final_prefix, sizeof(final_prefix),
        UNDO_FINAL_SCHEMA "\tRESTORE_QUARANTINE\t%s\t", request->operation);
      if (final_length <= 0 || (size_t)final_length >= sizeof(final_prefix) ||
          has_prefix(bytes, final_prefix)) { clean = false; break; }
      final_length = snprintf(final_prefix, sizeof(final_prefix),
        UNDO_FINAL_SCHEMA "\tFINALIZE_UNDO\t%s\t", request->operation);
      if (final_length <= 0 || (size_t)final_length >= sizeof(final_prefix) ||
          has_prefix(bytes, final_prefix)) { clean = false; break; }
      for (size_t i = 0U; i < request->count; i += 1U) {
        if ((controls != NULL && strcmp(bytes, controls[i]) == 0) ||
            (receipts != NULL && receipts[i][0] != '\0' && strcmp(bytes, receipts[i]) == 0)) {
          clean = false; break;
        }
        char prefix[512];
        int length = snprintf(prefix, sizeof(prefix), UNDO_CONTROL_SCHEMA "\t%s\t%s\t",
          request->operation, request->items[i].selected);
        if (length <= 0 || (size_t)length >= sizeof(prefix) || has_prefix(bytes, prefix)) {
          clean = false; break;
        }
        length = snprintf(prefix, sizeof(prefix), UNDO_RECEIPT_SCHEMA "\t%s\t%s\t",
          request->operation, request->items[i].selected);
        if (length <= 0 || (size_t)length >= sizeof(prefix) || has_prefix(bytes, prefix)) {
          clean = false; break;
        }
      }
      if (!clean) break;
    } else if (has_prefix(name, ".changes-history-native-undo-quarantine.")) {
      int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
      if (fd >= 0) {
        Identity identity; char content[72];
        if (hash_fd(fd, &identity, content, MAX_ARTIFACT_BYTES)) {
          for (size_t i = 0U; i < request->count; i += 1U) {
            if (strcmp(content, request->items[i].content) == 0) { clean = false; break; }
          }
        }
        (void)close(fd);
      }
      if (!clean) break;
    }
  }
  (void)closedir(stream);
  return clean;
}

static NameState undo_public_state(
  RootBinding *root, UndoItem *item, Identity *identity_out, int *fd_out,
  int *parent_out, Ancestor ancestors[MAX_ROOT_COMPONENTS], size_t *depth_out,
  char leaf[MAX_PATH_BYTES + 1U]
) {
  char ancestor_digest[72];
  if (!open_parent(root, item->path, ancestors, depth_out, parent_out, leaf, ancestor_digest) ||
      strcmp(ancestor_digest, item->ancestor) != 0 ||
      !revalidate_parent(root, ancestors, *depth_out)) return NAME_ERROR;
  int fd = openat(*parent_out, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? NAME_ABSENT : NAME_ERROR;
  char content[72];
  char created[72];
  bool exact = hash_fd(fd, identity_out, content, item->length) &&
    identity_out->nlink == 1U && identity_out->size == item->length &&
    strcmp(content, item->content) == 0 &&
    created_identity_digest(identity_out, item->ancestor, leaf, item->content, created) &&
    strcmp(created, item->created) == 0 && record_path_matches_fd(*parent_out, leaf, fd) &&
    revalidate_parent(root, ancestors, *depth_out);
  if (!exact) { (void)close(fd); return NAME_FOREIGN; }
  *fd_out = fd;
  return NAME_EXACT;
}

static NameState undo_quarantine_state(
  RootBinding *root, UndoItem *item, Identity *identity_out
) {
  int fd = openat(root->recovery_fd, item->quarantine_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? NAME_ABSENT : NAME_ERROR;
  char content[72];
  char identity_digest[72];
  bool exact = hash_fd(fd, identity_out, content, item->length) &&
    identity_out->nlink == 1U && identity_out->size == item->length &&
    strcmp(content, item->content) == 0 &&
    object_identity_digest(identity_out, content, identity_digest) &&
    strcmp(identity_digest, item->quarantine_digest) == 0 &&
    record_path_matches_fd(root->recovery_fd, item->quarantine_name, fd);
  (void)close(fd);
  return exact ? NAME_EXACT : NAME_FOREIGN;
}

static bool undo_output(const UndoRequest *request, const char *state, const char *error) {
  char line[MAX_LINE_BYTES + 1U];
  size_t token_count = strcmp(state, "COMMITTED") == 0 ? request->count : 0U;
  int length = snprintf(line, sizeof(line), "%c\tRESULT\t%s\t%s\t%s\t%s\t%s\t%s\t%zu\t%s\n",
    request->command, state, request->operation, request->artifact, request->phase,
    request->selection, request->prepared_history, token_count, error);
  if (length <= 0 || (size_t)length >= sizeof(line) || !write_line(line)) return false;
  for (size_t i = 0U; i < token_count; i += 1U) {
    const UndoItem *item = &request->items[i];
    size_t used = (size_t)snprintf(line, sizeof(line),
      "U\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s",
      item->selected, item->control_name, item->receipt_name, item->quarantine_name,
      item->control_digest, item->created, item->quarantine_digest, item->content,
      item->receipt_digest);
    if (used >= sizeof(line) || !append_identity(line, sizeof(line), &used, &item->control_record) ||
        !append_identity(line, sizeof(line), &used, &item->receipt_record) ||
        used + 2U > sizeof(line)) return false;
    line[used++] = '\n'; line[used] = '\0';
    if (!write_line(line)) return false;
  }
  return true;
}

static bool undo_committed_response_fits(const UndoRequest *request) {
  size_t projected = 2048U;
  for (size_t i = 0U; i < request->count; i += 1U) {
    size_t item = 1200U + strlen(request->items[i].selected);
    if (projected > MAX_OUTPUT_BYTES - item) return false;
    projected += item;
  }
  return projected <= MAX_OUTPUT_BYTES;
}

static NameState load_undo_receipt(
  RootBinding *root, const UndoRequest *request, UndoItem *item,
  const char *control, char receipt[MAX_RECORD_BYTES + 1U]
) {
  int fd = openat(root->recovery_fd, item->receipt_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? NAME_ABSENT : NAME_ERROR;
  char bytes[MAX_RECORD_BYTES + 1U];
  ssize_t length = pread(fd, bytes, MAX_RECORD_BYTES, 0);
  struct stat value;
  Identity identity;
  bool valid = length > 0 && length <= (ssize_t)MAX_RECORD_BYTES &&
    fstat(fd, &value) == 0 && identity_from_stat(&value, &identity) &&
    S_ISREG(value.st_mode) && value.st_uid == geteuid() &&
    (value.st_mode & 0777) == 0600 && value.st_nlink == 1 &&
    record_path_matches_fd(root->recovery_fd, item->receipt_name, fd);
  (void)close(fd);
  if (!valid) return NAME_FOREIGN;
  bytes[length] = '\0';
  if (bytes[length - 1U] != '\n') return NAME_FOREIGN;
  char copy[MAX_RECORD_BYTES + 1U];
  memcpy(copy, bytes, (size_t)length + 1U);
  copy[length - 1U] = '\0';
  char *fields[13];
  size_t count = 0U;
  uint64_t byte_length;
  if (!split_fields(copy, fields, 13U, &count) || count != 12U ||
      strcmp(fields[0], UNDO_RECEIPT_SCHEMA) != 0 ||
      strcmp(fields[1], request->operation) != 0 || strcmp(fields[2], item->selected) != 0 ||
      strcmp(fields[3], item->control_digest) != 0 ||
      !has_prefix(fields[4], ".changes-history-native-undo-quarantine.") ||
      strlen(fields[4]) != strlen(".changes-history-native-undo-quarantine.") + 32U ||
      strcmp(fields[5], item->created) != 0 || !valid_digest(fields[6]) ||
      strcmp(fields[7], item->content) != 0 ||
      !parse_uint(fields[8], MAX_ARTIFACT_BYTES, &byte_length) || byte_length != item->length ||
      strcmp(fields[9], "1") != 0 || strcmp(fields[10], "1") != 0 ||
      !valid_digest(fields[11])) return NAME_FOREIGN;
  for (const char *c = fields[4] + strlen(".changes-history-native-undo-quarantine."); *c; c += 1U) {
    if (hex_value(*c) < 0) return NAME_FOREIGN;
  }
  memcpy(item->quarantine_name, fields[4], strlen(fields[4]) + 1U);
  memcpy(item->quarantine_digest, fields[6], DIGEST_BYTES + 1U);
  if (!build_undo_receipt(request, item, receipt) ||
      strcmp(item->receipt_digest, fields[11]) != 0 || strcmp(receipt, bytes) != 0 ||
      record_state(root->recovery_fd, item->control_name, control) != NAME_EXACT) return NAME_FOREIGN;
  item->receipt_record.identity = identity;
  sha256_prefixed((const unsigned char *)bytes, (size_t)length, item->receipt_record.content);
  return NAME_EXACT;
}

static bool undo_quarantine_one(RootBinding *root, UndoItem *item) {
  Ancestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  for (size_t x = 0U; x < MAX_ROOT_COMPONENTS; x += 1U) ancestors[x].fd = -1;
  size_t depth = 0U;
  int parent = -1;
  int leaf_fd = -1;
  char leaf[MAX_PATH_BYTES + 1U];
  Identity public_identity;
  NameState state = undo_public_state(root, item, &public_identity, &leaf_fd,
    &parent, ancestors, &depth, leaf);
  if (state != NAME_EXACT || !random_undo_quarantine(item->quarantine_name)) {
    if (leaf_fd >= 0) (void)close(leaf_fd);
    close_parent(ancestors, depth, parent);
    return false;
  }
  struct stat ignored;
  bool moved = fstatat(root->recovery_fd, item->quarantine_name,
      &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT &&
    record_path_matches_fd(parent, leaf, leaf_fd) &&
    renameatx_np(parent, leaf, root->recovery_fd, item->quarantine_name, RENAME_EXCL) == 0;
  if (!moved) {
    (void)close(leaf_fd);
    close_parent(ancestors, depth, parent);
    return false;
  }
#ifdef WRITCRAFT_TEST_PAUSE_UNDO_AFTER_RENAME
  if (!test_sync_point("undo-after-rename")) {
    (void)close(leaf_fd); close_parent(ancestors, depth, parent); return false;
  }
#endif
#ifdef WRITCRAFT_TEST_CRASH_UNDO_AFTER_RENAME
  _exit(111);
#endif
  bool public_absent = fstatat(parent, leaf, &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
  int quarantine_fd = openat(root->recovery_fd, item->quarantine_name,
    O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity quarantine_identity;
  char content[72];
  char quarantine_digest[72];
  bool valid = public_absent && quarantine_fd >= 0 &&
    hash_fd(quarantine_fd, &quarantine_identity, content, item->length) &&
    same_bound_record(&public_identity, &quarantine_identity) &&
    strcmp(content, item->content) == 0 &&
    record_path_matches_fd(root->recovery_fd, item->quarantine_name, quarantine_fd) &&
    revalidate_parent(root, ancestors, depth) &&
    object_identity_digest(&quarantine_identity, content, quarantine_digest);
  if (quarantine_fd >= 0) (void)close(quarantine_fd);
  (void)close(leaf_fd);
  if (!valid || fsync(parent) != 0 || fsync(root->recovery_fd) != 0 ||
      !open_recovery(root, false)) {
    close_parent(ancestors, depth, parent);
    return false;
  }
  memcpy(item->quarantine_digest, quarantine_digest, DIGEST_BYTES + 1U);
  close_parent(ancestors, depth, parent);
  return true;
}

static bool undo_commit_exact(
  RootBinding *root, UndoRequest *request,
  const char (*controls)[MAX_RECORD_BYTES + 1U],
  const char (*receipts)[MAX_RECORD_BYTES + 1U]
) {
  if (!undo_authority_valid(root, request)) return false;
  for (size_t i = 0U; i < request->count; i += 1U) {
    UndoItem *item = &request->items[i];
    if (!record_identity_exact(root->recovery_fd, item->control_name, controls[i],
          &item->control_record) ||
        !record_identity_exact(root->recovery_fd, item->receipt_name, receipts[i],
          &item->receipt_record)) return false;
    Identity quarantine_identity;
    if (undo_quarantine_state(root, item, &quarantine_identity) != NAME_EXACT) return false;
    Ancestor ancestors[MAX_ROOT_COMPONENTS];
    memset(ancestors, 0, sizeof(ancestors));
    for (size_t x = 0U; x < MAX_ROOT_COMPONENTS; x += 1U) ancestors[x].fd = -1;
    size_t depth = 0U; int parent = -1; int fd = -1; char leaf[MAX_PATH_BYTES + 1U];
    Identity ignored;
    NameState public_state = undo_public_state(root, item, &ignored, &fd,
      &parent, ancestors, &depth, leaf);
    if (fd >= 0) (void)close(fd);
    close_parent(ancestors, depth, parent);
    if (public_state != NAME_ABSENT) return false;
  }
  return fsync(root->recovery_fd) == 0 && open_recovery(root, false);
}

static bool undo_quarantine(RootBinding *root, UndoRequest *request) {
  char (*controls)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*controls));
  char (*receipts)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*receipts));
  if (controls == NULL || receipts == NULL) goto unknown;
  if (!undo_authority_valid(root, request)) goto unknown;
  for (size_t i = 0U; i < request->count; i += 1U) {
    if (!build_undo_control(request, &request->items[i], controls[i]) ||
        record_state(root->recovery_fd, request->items[i].control_name, controls[i]) != NAME_ABSENT ||
        record_state(root->recovery_fd, request->items[i].receipt_name, "") != NAME_ABSENT) goto unknown;
    Ancestor ancestors[MAX_ROOT_COMPONENTS]; memset(ancestors, 0, sizeof(ancestors));
    for (size_t x = 0U; x < MAX_ROOT_COMPONENTS; x += 1U) ancestors[x].fd = -1;
    size_t depth = 0U; int parent = -1; int fd = -1; char leaf[MAX_PATH_BYTES + 1U]; Identity identity;
    NameState public_state = undo_public_state(root, &request->items[i], &identity, &fd,
      &parent, ancestors, &depth, leaf);
    if (fd >= 0) (void)close(fd); close_parent(ancestors, depth, parent);
    if (public_state != NAME_EXACT) goto unknown;
  }
  if (!undo_namespace_clean(root->recovery_fd, request, controls, NULL, NULL, NULL)) goto unknown;
  if (!undo_committed_response_fits(request)) {
    bool clean = fsync(root->recovery_fd) == 0 && open_recovery(root, false);
    bool result = undo_output(request, clean ? "UNCOMMITTED" : "UNKNOWN",
      clean ? "-" : "UNKNOWN");
    free(controls); free(receipts); return result;
  }
  size_t written = 0U;
  RecordAttempt failed_attempt;
  memset(&failed_attempt, 0, sizeof(failed_attempt));
  failed_attempt.fd = -1;
  for (; written < request->count; written += 1U) {
    Identity identity;
    if (!write_record(root->recovery_fd, request->items[written].control_name,
        controls[written], &identity, &failed_attempt)) break;
    request->items[written].control_record.identity = identity;
    sha256_prefixed((const unsigned char *)controls[written], strlen(controls[written]),
      request->items[written].control_record.content);
  }
  if (written != request->count) {
    bool clean = failed_attempt.created && failed_attempt.identity_bound;
#ifdef WRITCRAFT_TEST_PAUSE_CONTROL_FAILURE_BEFORE_CLEANUP
    if (failed_attempt.created &&
        !test_sync_point("control-failure-before-cleanup")) clean = false;
#endif
    if (failed_attempt.created && failed_attempt.identity_bound) {
      clean = unlink_attempted_record_owned(root->recovery_fd,
        request->items[written].control_name, controls[written], &failed_attempt) && clean;
    }
    if (failed_attempt.fd >= 0) (void)close(failed_attempt.fd);
    for (size_t i = 0U; i < written; i += 1U) {
      clean = unlink_exact_record_owned(root->recovery_fd, request->items[i].control_name,
        controls[i], &request->items[i].control_record.identity, -1) && clean;
    }
    for (size_t i = 0U; i < request->count; i += 1U) {
      struct stat ignored;
      clean = fstatat(root->recovery_fd, request->items[i].control_name,
          &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT &&
        fstatat(root->recovery_fd, request->items[i].receipt_name,
          &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT && clean;
      Ancestor ancestors[MAX_ROOT_COMPONENTS]; memset(ancestors, 0, sizeof(ancestors));
      for (size_t x = 0U; x < MAX_ROOT_COMPONENTS; x += 1U) ancestors[x].fd = -1;
      size_t depth = 0U; int parent = -1; int fd = -1; char leaf[MAX_PATH_BYTES + 1U]; Identity public_identity;
      NameState public_state = undo_public_state(root, &request->items[i], &public_identity, &fd,
        &parent, ancestors, &depth, leaf);
      if (fd >= 0) (void)close(fd); close_parent(ancestors, depth, parent);
      clean = public_state == NAME_EXACT && clean;
    }
    clean = undo_namespace_clean(root->recovery_fd, request, controls, NULL, NULL, NULL) &&
      fsync(root->recovery_fd) == 0 && open_recovery(root, false) && clean;
    bool result = undo_output(request, clean ? "UNCOMMITTED" : "UNKNOWN", clean ? "-" : "UNKNOWN");
    free(controls); free(receipts); return result;
  }
#ifdef WRITCRAFT_TEST_PAUSE_UNDO_AFTER_CONTROLS
  if (!test_sync_point("undo-after-controls")) goto unknown_allocated;
#endif
  for (size_t i = 0U; i < request->count; i += 1U) {
    if (!undo_quarantine_one(root, &request->items[i]) ||
        !build_undo_receipt(request, &request->items[i], receipts[i]) ||
        !write_record(root->recovery_fd, request->items[i].receipt_name, receipts[i],
          &request->items[i].receipt_record.identity, NULL)) goto unknown_allocated;
    sha256_prefixed((const unsigned char *)receipts[i], strlen(receipts[i]),
      request->items[i].receipt_record.content);
#ifdef WRITCRAFT_TEST_PAUSE_UNDO_AFTER_RECEIPT
    if (!test_sync_point("undo-after-receipt")) goto unknown_allocated;
#endif
#ifdef WRITCRAFT_TEST_CRASH_UNDO_AFTER_RECEIPT
    _exit(112);
#endif
  }
  if (!undo_commit_exact(root, request, controls, receipts)) goto unknown_allocated;
#ifdef WRITCRAFT_TEST_DROP_UNDO_COMMITTED_RESPONSE
  _exit(113);
#endif
  {
    bool result = undo_output(request, "COMMITTED", "-");
    free(controls); free(receipts); return result;
  }
unknown_allocated:
  {
    bool result = undo_output(request, "UNKNOWN", "UNKNOWN");
    free(controls); free(receipts); return result;
  }
unknown:
  free(controls); free(receipts);
  return undo_output(request, "UNKNOWN", "UNKNOWN");
}

static bool undo_reconcile(RootBinding *root, UndoRequest *request) {
  char (*controls)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*controls));
  char (*receipts)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*receipts));
  if (controls == NULL || receipts == NULL || !undo_authority_valid(root, request)) goto unknown;
  bool all_absent = true;
  bool all_committed = true;
  for (size_t i = 0U; i < request->count; i += 1U) {
    UndoItem *item = &request->items[i];
    if (!build_undo_control(request, item, controls[i])) goto unknown;
    NameState control = record_state(root->recovery_fd, item->control_name, controls[i]);
    if (control == NAME_ABSENT) {
      all_committed = false;
      Ancestor ancestors[MAX_ROOT_COMPONENTS]; memset(ancestors, 0, sizeof(ancestors));
      for (size_t x = 0U; x < MAX_ROOT_COMPONENTS; x += 1U) ancestors[x].fd = -1;
      size_t depth = 0U; int parent = -1; int fd = -1; char leaf[MAX_PATH_BYTES + 1U]; Identity identity;
      NameState public_state = undo_public_state(root, item, &identity, &fd, &parent, ancestors, &depth, leaf);
      if (fd >= 0) (void)close(fd); close_parent(ancestors, depth, parent);
      if (public_state != NAME_EXACT) all_absent = false;
      continue;
    }
    all_absent = false;
    if (control != NAME_EXACT || !capture_record_identity(root->recovery_fd,
        item->control_name, controls[i], &item->control_record) ||
        load_undo_receipt(root, request, item, controls[i], receipts[i]) != NAME_EXACT ||
        !record_identity_exact(root->recovery_fd, item->receipt_name, receipts[i],
          &item->receipt_record)) { all_committed = false; continue; }
    Identity quarantine_identity;
    if (undo_quarantine_state(root, item, &quarantine_identity) != NAME_EXACT) all_committed = false;
    Ancestor ancestors[MAX_ROOT_COMPONENTS]; memset(ancestors, 0, sizeof(ancestors));
    for (size_t x = 0U; x < MAX_ROOT_COMPONENTS; x += 1U) ancestors[x].fd = -1;
    size_t depth = 0U; int parent = -1; int fd = -1; char leaf[MAX_PATH_BYTES + 1U]; Identity identity;
    NameState public_state = undo_public_state(root, item, &identity, &fd, &parent, ancestors, &depth, leaf);
    if (fd >= 0) (void)close(fd); close_parent(ancestors, depth, parent);
    if (public_state != NAME_ABSENT) all_committed = false;
  }
  if (all_committed && undo_committed_response_fits(request) &&
      undo_commit_exact(root, request, controls, receipts)) {
    if (!undo_namespace_clean(root->recovery_fd, request, controls, receipts, NULL, NULL)) goto unknown;
    bool result = undo_output(request, "COMMITTED", "-");
    free(controls); free(receipts); return result;
  }
  if (all_absent && undo_namespace_clean(root->recovery_fd, request,
      controls, receipts, NULL, NULL) && fsync(root->recovery_fd) == 0 &&
      open_recovery(root, false)) {
    bool result = undo_output(request, "UNCOMMITTED", "-");
    free(controls); free(receipts); return result;
  }
unknown:
  free(controls); free(receipts);
  return undo_output(request, "UNKNOWN", "UNKNOWN");
}

static bool undo_settle_header(char *line, UndoRequest *request) {
  char *fields[15];
  size_t count = 0U;
  uint64_t item_count;
  if (!split_fields(line, fields, 15U, &count) || count != 14U ||
      !(strcmp(fields[0], "B") == 0 || strcmp(fields[0], "D") == 0) ||
      strcmp(fields[1], "UNDO") != 0 || !valid_operation(fields[2]) ||
      !valid_digest(fields[3]) || !valid_digest(fields[4]) ||
      !parse_uint(fields[5], MAX_ARTIFACT_BYTES, &request->artifact_length) ||
      request->artifact_length == 0U || !valid_digest(fields[6]) ||
      !valid_digest(fields[7]) || !valid_digest(fields[8]) || !valid_digest(fields[9]) ||
      !valid_digest(fields[10]) ||
      (fields[0][0] == 'B' ? strcmp(fields[11], "-") != 0 : !valid_digest(fields[11])) ||
      !valid_digest(fields[12]) || !parse_uint(fields[13], MAX_ITEMS, &item_count) ||
      item_count == 0U) return false;
  request->command = fields[0][0];
  memcpy(request->operation, fields[2], strlen(fields[2]) + 1U);
  memcpy(request->artifact, fields[3], DIGEST_BYTES + 1U);
  memcpy(request->artifact_identity, fields[4], DIGEST_BYTES + 1U);
  memcpy(request->root_digest, fields[6], DIGEST_BYTES + 1U);
  memcpy(request->recovery_digest, fields[7], DIGEST_BYTES + 1U);
  memcpy(request->phase, fields[8], DIGEST_BYTES + 1U);
  memcpy(request->selection, fields[9], DIGEST_BYTES + 1U);
  memcpy(request->prepared_history, fields[10], DIGEST_BYTES + 1U);
  memcpy(request->history_phase, fields[11], strlen(fields[11]) + 1U);
  memcpy(request->receipt_set, fields[12], DIGEST_BYTES + 1U);
  request->count = (size_t)item_count;
  return true;
}

static bool undo_token_line(char *line, UndoRequest *request, size_t index) {
  char *fields[32];
  size_t count = 0U;
  UndoItem *item = &request->items[index];
  if (!split_fields(line, fields, 32U, &count) || count != 31U || strcmp(fields[0], "U") != 0 ||
      !valid_selected(fields[1]) || !decode_hex(fields[2], item->path, sizeof(item->path)) ||
      !strict_utf8((const unsigned char *)item->path, strlen(item->path)) ||
      !valid_public_path(item->path) ||
      !parse_uint(fields[3], request->artifact_length, &item->length) || item->length == 0U ||
      !valid_digest(fields[4]) || !valid_digest(fields[5]) || !valid_digest(fields[6]) ||
      strlen(fields[7]) >= sizeof(item->control_name) ||
      strlen(fields[8]) >= sizeof(item->receipt_name) ||
      strlen(fields[9]) >= sizeof(item->quarantine_name) ||
      !has_prefix(fields[7], ".changes-history-native-undo-control.") ||
      !has_prefix(fields[8], ".changes-history-native-undo-receipt.") ||
      !has_prefix(fields[9], ".changes-history-native-undo-quarantine.") ||
      !valid_digest(fields[10]) || !valid_digest(fields[11]) || !valid_digest(fields[12]) ||
      !parse_identity_fields(fields, 13U, &item->control_record) ||
      !parse_identity_fields(fields, 22U, &item->receipt_record)) return false;
  memcpy(item->selected, fields[1], strlen(fields[1]) + 1U);
  memcpy(item->content, fields[4], DIGEST_BYTES + 1U);
  memcpy(item->ancestor, fields[5], DIGEST_BYTES + 1U);
  memcpy(item->created, fields[6], DIGEST_BYTES + 1U);
  memcpy(item->control_name, fields[7], strlen(fields[7]) + 1U);
  memcpy(item->receipt_name, fields[8], strlen(fields[8]) + 1U);
  memcpy(item->quarantine_name, fields[9], strlen(fields[9]) + 1U);
  memcpy(item->control_digest, fields[10], DIGEST_BYTES + 1U);
  memcpy(item->quarantine_digest, fields[11], DIGEST_BYTES + 1U);
  memcpy(item->receipt_digest, fields[12], DIGEST_BYTES + 1U);
  for (size_t i = 0U; i < index; i += 1U) {
    if (strcmp(request->items[i].selected, item->selected) == 0 ||
        strcmp(request->items[i].path, item->path) == 0 ||
        strcmp(request->items[i].created, item->created) == 0 ||
        strcmp(request->items[i].quarantine_name, item->quarantine_name) == 0) return false;
  }
  return true;
}

static bool undo_records_exact(
  RootBinding *root, UndoRequest *request,
  char (*controls)[MAX_RECORD_BYTES + 1U],
  char (*receipts)[MAX_RECORD_BYTES + 1U]
) {
  if (!undo_authority_valid(root, request)) return false;
  for (size_t i = 0U; i < request->count; i += 1U) {
    UndoItem *item = &request->items[i];
    char supplied_control[128]; char supplied_receipt[128]; char supplied_control_digest[72];
    char supplied_receipt_digest[72];
    memcpy(supplied_control, item->control_name, sizeof(supplied_control));
    memcpy(supplied_receipt, item->receipt_name, sizeof(supplied_receipt));
    memcpy(supplied_control_digest, item->control_digest, sizeof(supplied_control_digest));
    memcpy(supplied_receipt_digest, item->receipt_digest, sizeof(supplied_receipt_digest));
    if (!build_undo_control(request, item, controls[i]) ||
        strcmp(item->control_name, supplied_control) != 0 ||
        strcmp(item->receipt_name, supplied_receipt) != 0 ||
        strcmp(item->control_digest, supplied_control_digest) != 0 ||
        !record_identity_exact(root->recovery_fd, item->control_name, controls[i],
        &item->control_record) || !build_undo_receipt(request, item, receipts[i]) ||
        strcmp(item->receipt_digest, supplied_receipt_digest) != 0 ||
        !record_identity_exact(root->recovery_fd, item->receipt_name, receipts[i],
          &item->receipt_record)) return false;
  }
  return open_recovery(root, false);
}

static bool undo_receipt_set_digest(const UndoRequest *request, char out[72]) {
  size_t capacity = 1024U + (request->count * 2048U);
  char *canonical = malloc(capacity);
  if (canonical == NULL) return false;
  int length = snprintf(canonical, capacity, "{\"artifactDigest\":\"%s\",\"items\":[",
    request->artifact);
  bool valid = length > 0 && (size_t)length < capacity;
  size_t used = valid ? (size_t)length : 0U;
  for (size_t i = 0U; valid && i < request->count; i += 1U) {
    const UndoItem *item = &request->items[i];
    char control_identity[72]; char receipt_identity[72];
    valid = object_identity_digest(&item->control_record.identity,
      item->control_record.content, control_identity) &&
      object_identity_digest(&item->receipt_record.identity,
        item->receipt_record.content, receipt_identity);
    if (!valid) break;
    length = snprintf(canonical + used, capacity - used,
      "%s{\"controlDigest\":\"%s\",\"controlRecordIdentityDigest\":\"%s\""
      ",\"createdIdentityDigest\":\"%s\",\"quarantineIdentityDigest\":\"%s\""
      ",\"receiptDigest\":\"%s\",\"receiptRecordIdentityDigest\":\"%s\""
      ",\"selectedId\":\"%s\"}", i == 0U ? "" : ",", item->control_digest,
      control_identity, item->created, item->quarantine_digest, item->receipt_digest,
      receipt_identity, item->selected);
    valid = length > 0 && (size_t)length < capacity - used;
    if (valid) used += (size_t)length;
  }
  if (valid) {
    length = snprintf(canonical + used, capacity - used,
      "],\"operationId\":\"%s\",\"precreatePhaseDigest\":\"%s\""
      ",\"preparedHistoryDigest\":\"%s\",\"schema\":\"" UNDO_RECEIPT_SET_SCHEMA
      "\",\"selectionDigest\":\"%s\"}", request->operation, request->phase,
      request->prepared_history, request->selection);
    valid = length > 0 && (size_t)length < capacity - used;
  }
  valid = valid && digest_domain(UNDO_RECEIPT_SET_SCHEMA, canonical, out);
  free(canonical);
  return valid;
}

static bool build_undo_final(UndoRequest *request, char record[4097]) {
  char set_digest[72];
  if (!undo_receipt_set_digest(request, set_digest) ||
      strcmp(set_digest, request->receipt_set) != 0) return false;
  const char *command = request->command == 'B' ? "RESTORE_QUARANTINE" : "FINALIZE_UNDO";
  char history_json[96];
  if (request->command == 'B') memcpy(history_json, "null", 5U);
  else {
    int h = snprintf(history_json, sizeof(history_json), "\"%s\"", request->history_phase);
    if (h <= 0 || (size_t)h >= sizeof(history_json)) return false;
  }
  char key[2048];
  int length = snprintf(key, sizeof(key),
    "{\"artifactDigest\":\"%s\",\"command\":\"%s\",\"historyCommittedPhaseDigest\":%s"
    ",\"operationId\":\"%s\",\"precreatePhaseDigest\":\"%s\""
    ",\"preparedHistoryDigest\":\"%s\",\"receiptSetDigest\":\"%s\""
    ",\"schema\":\"" UNDO_FINAL_KEY_SCHEMA "\",\"selectionDigest\":\"%s\"}",
    request->artifact, command, history_json, request->operation, request->phase,
    request->prepared_history, set_digest, request->selection);
  char key_digest[72];
  if (length <= 0 || (size_t)length >= sizeof(key) ||
      !digest_domain(UNDO_FINAL_KEY_SCHEMA, key, key_digest)) return false;
  length = snprintf(request->final_name, sizeof(request->final_name),
    ".changes-history-native-undo-final.%s", key_digest + 7U);
  if (length <= 0 || (size_t)length >= sizeof(request->final_name)) return false;
  char canonical[4097];
  length = snprintf(canonical, sizeof(canonical),
    "{\"artifactDigest\":\"%s\",\"command\":\"%s\",\"historyCommittedPhaseDigest\":%s"
    ",\"itemCount\":%zu,\"operationId\":\"%s\",\"precreatePhaseDigest\":\"%s\""
    ",\"preparedHistoryDigest\":\"%s\",\"publicParentFsyncComplete\":true"
    ",\"receiptSetDigest\":\"%s\",\"recoveryFsyncComplete\":true"
    ",\"schema\":\"" UNDO_FINAL_SCHEMA "\",\"selectionDigest\":\"%s\"}",
    request->artifact, command, history_json, request->count, request->operation,
    request->phase, request->prepared_history, set_digest, request->selection);
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(UNDO_FINAL_SCHEMA, canonical, request->final_digest)) return false;
  length = snprintf(record, 4097U,
    UNDO_FINAL_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%zu\t1\t1\t%s\n",
    command, request->operation, request->artifact, request->phase, request->selection,
    request->prepared_history, request->history_phase, set_digest, request->count,
    request->final_digest);
  return length > 0 && length < 4097;
}

static bool restore_quarantine_one(RootBinding *root, UndoItem *item) {
  Ancestor ancestors[MAX_ROOT_COMPONENTS]; memset(ancestors, 0, sizeof(ancestors));
  for (size_t x = 0U; x < MAX_ROOT_COMPONENTS; x += 1U) ancestors[x].fd = -1;
  size_t depth = 0U; int parent = -1; char leaf[MAX_PATH_BYTES + 1U]; char ancestor[72];
  if (!open_parent(root, item->path, ancestors, &depth, &parent, leaf, ancestor) ||
      strcmp(ancestor, item->ancestor) != 0 || !revalidate_parent(root, ancestors, depth)) {
    close_parent(ancestors, depth, parent); return false;
  }
  struct stat ignored;
  int held = openat(root->recovery_fd, item->quarantine_name,
    O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity before; char content[72]; char digest[72];
  bool valid = held >= 0 && fstatat(parent, leaf, &ignored, AT_SYMLINK_NOFOLLOW) != 0 &&
    errno == ENOENT && hash_fd(held, &before, content, item->length) &&
    strcmp(content, item->content) == 0 && object_identity_digest(&before, content, digest) &&
    strcmp(digest, item->quarantine_digest) == 0 &&
    record_path_matches_fd(root->recovery_fd, item->quarantine_name, held) &&
    renameatx_np(root->recovery_fd, item->quarantine_name, parent, leaf, RENAME_EXCL) == 0;
  if (!valid) { if (held >= 0) (void)close(held); close_parent(ancestors, depth, parent); return false; }
#ifdef WRITCRAFT_TEST_CRASH_UNDO_SETTLE_AFTER_MUTATION
  _exit(114);
#endif
  int public_fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity after;
  valid = public_fd >= 0 && hash_fd(public_fd, &after, content, item->length) &&
    same_bound_record(&before, &after) && strcmp(content, item->content) == 0 &&
    record_path_matches_fd(parent, leaf, public_fd) &&
    fstatat(root->recovery_fd, item->quarantine_name, &ignored, AT_SYMLINK_NOFOLLOW) != 0 &&
    errno == ENOENT && revalidate_parent(root, ancestors, depth) &&
    fsync(parent) == 0 && fsync(root->recovery_fd) == 0;
  if (public_fd >= 0) (void)close(public_fd); (void)close(held);
  close_parent(ancestors, depth, parent);
  return valid;
}

static bool finalize_quarantine_one(RootBinding *root, UndoItem *item) {
  int held = openat(root->recovery_fd, item->quarantine_name,
    O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity before; char content[72]; char digest[72]; char temporary[128]; struct stat ignored;
  bool valid = held >= 0 && hash_fd(held, &before, content, item->length) &&
    strcmp(content, item->content) == 0 && object_identity_digest(&before, content, digest) &&
    strcmp(digest, item->quarantine_digest) == 0 &&
    record_path_matches_fd(root->recovery_fd, item->quarantine_name, held) &&
    random_undo_quarantine(temporary) &&
    fstatat(root->recovery_fd, temporary, &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT &&
    renameatx_np(root->recovery_fd, item->quarantine_name,
      root->recovery_fd, temporary, RENAME_EXCL) == 0;
  if (!valid) { if (held >= 0) (void)close(held); return false; }
  int moved = openat(root->recovery_fd, temporary, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity after;
  valid = moved >= 0 && hash_fd(moved, &after, content, item->length) &&
    same_bound_record(&before, &after) && strcmp(content, item->content) == 0 &&
    record_path_matches_fd(root->recovery_fd, temporary, moved) &&
    fstatat(root->recovery_fd, item->quarantine_name, &ignored, AT_SYMLINK_NOFOLLOW) != 0 &&
    errno == ENOENT && unlinkat(root->recovery_fd, temporary, 0) == 0;
#ifdef WRITCRAFT_TEST_CRASH_UNDO_SETTLE_AFTER_MUTATION
  if (valid) _exit(114);
#endif
  if (moved >= 0) (void)close(moved); (void)close(held);
  return valid && fsync(root->recovery_fd) == 0;
}

static bool undo_branch_public_state(RootBinding *root, UndoRequest *request, bool committed) {
  for (size_t i = 0U; i < request->count; i += 1U) {
    UndoItem *item = &request->items[i];
    Ancestor ancestors[MAX_ROOT_COMPONENTS]; memset(ancestors, 0, sizeof(ancestors));
    for (size_t x = 0U; x < MAX_ROOT_COMPONENTS; x += 1U) ancestors[x].fd = -1;
    size_t depth = 0U; int parent = -1; int fd = -1; char leaf[MAX_PATH_BYTES + 1U]; Identity identity;
    NameState public_state = undo_public_state(root, item, &identity, &fd,
      &parent, ancestors, &depth, leaf);
    if (fd >= 0) (void)close(fd); close_parent(ancestors, depth, parent);
    NameState quarantine_state = undo_quarantine_state(root, item, &identity);
    bool expected = request->command == 'B'
      ? (committed ? public_state == NAME_EXACT && quarantine_state == NAME_ABSENT
                   : public_state == NAME_ABSENT && quarantine_state == NAME_EXACT)
      : (committed ? public_state == NAME_ABSENT && quarantine_state == NAME_ABSENT
                   : public_state == NAME_ABSENT && quarantine_state == NAME_EXACT);
    if (!expected) return false;
  }
  return open_recovery(root, false);
}

static bool undo_settle_output(
  UndoRequest *request, const char *state, const char *error, const char *record
) {
  char line[MAX_LINE_BYTES + 1U];
  size_t count = strcmp(state, "COMMITTED") == 0 ? 1U : 0U;
  int length = snprintf(line, sizeof(line), "%c\tRESULT\t%s\t%s\t%zu\t%s\n",
    request->command, state, request->operation, count, error);
  if (length <= 0 || (size_t)length >= sizeof(line) || !write_line(line)) return false;
  if (count == 0U) return true;
  size_t used = (size_t)snprintf(line, sizeof(line), "V\t%s\t%s",
    request->final_name, request->final_digest);
  if (used >= sizeof(line) || !append_identity(line, sizeof(line), &used, &request->final_record) ||
      used + 2U > sizeof(line)) return false;
  line[used++] = '\n'; line[used] = '\0';
  (void)record;
  return write_line(line);
}

static bool undo_settle(RootBinding *root, UndoRequest *request) {
  char (*controls)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*controls));
  char (*receipts)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*receipts));
  char final_record[4097];
  if (controls == NULL || receipts == NULL || !undo_records_exact(root, request, controls, receipts) ||
      !build_undo_final(request, final_record) ||
      !undo_namespace_clean(root->recovery_fd, request, controls, receipts,
        request->final_name, final_record)) goto unknown;
  NameState final_state = record_state(root->recovery_fd, request->final_name, final_record);
  if (final_state == NAME_EXACT) {
    if (!capture_record_identity(root->recovery_fd, request->final_name, final_record,
          &request->final_record) || !undo_branch_public_state(root, request, true)) goto unknown;
    bool result = undo_settle_output(request, "COMMITTED", "-", final_record);
    free(controls); free(receipts); return result;
  }
  if (final_state != NAME_ABSENT || !undo_branch_public_state(root, request, false)) goto unknown;
  for (size_t i = 0U; i < request->count; i += 1U) {
    bool ok = request->command == 'B' ? restore_quarantine_one(root, &request->items[i]) :
      finalize_quarantine_one(root, &request->items[i]);
    if (!ok) goto unknown;
  }
#ifdef WRITCRAFT_TEST_PAUSE_UNDO_SETTLE_AFTER_MUTATION
  if (!test_sync_point("undo-settle-after-mutation")) goto unknown;
#endif
  if (!undo_branch_public_state(root, request, true) ||
      !write_record(root->recovery_fd, request->final_name, final_record,
        &request->final_record.identity, NULL)) goto unknown;
  sha256_prefixed((const unsigned char *)final_record, strlen(final_record),
    request->final_record.content);
  if (!record_identity_exact(root->recovery_fd, request->final_name, final_record,
      &request->final_record) || !open_recovery(root, false) ||
      !undo_namespace_clean(root->recovery_fd, request, controls, receipts,
        request->final_name, final_record)) goto unknown;
#ifdef WRITCRAFT_TEST_PAUSE_UNDO_SETTLE_AFTER_FINAL
  if (!test_sync_point("undo-settle-after-final")) goto unknown;
#endif
  if (!undo_authority_valid(root, request) ||
      !undo_records_exact(root, request, controls, receipts) ||
      !record_identity_exact(root->recovery_fd, request->final_name, final_record,
        &request->final_record) || !undo_branch_public_state(root, request, true) ||
      !undo_namespace_clean(root->recovery_fd, request, controls, receipts,
        request->final_name, final_record)) goto unknown;
#ifdef WRITCRAFT_TEST_DROP_UNDO_SETTLE_RESPONSE
  _exit(115);
#endif
  {
    bool result = undo_settle_output(request, "COMMITTED", "-", final_record);
    free(controls); free(receipts); return result;
  }
unknown:
  free(controls); free(receipts);
  return undo_settle_output(request, "UNKNOWN", "UNKNOWN", NULL);
}

static bool undo_ack_header(char *line, UndoRequest *request) {
  char *fields[27];
  size_t count = 0U;
  uint64_t item_count;
  if (!split_fields(line, fields, 27U, &count) || count != 26U ||
      strcmp(fields[0], "A") != 0 || strcmp(fields[1], "UNDO") != 0 ||
      !(strcmp(fields[2], "RESTORE_QUARANTINE") == 0 || strcmp(fields[2], "FINALIZE_UNDO") == 0) ||
      !valid_operation(fields[3]) || !valid_digest(fields[4]) || !valid_digest(fields[5]) ||
      !parse_uint(fields[6], MAX_ARTIFACT_BYTES, &request->artifact_length) ||
      request->artifact_length == 0U || !valid_digest(fields[7]) || !valid_digest(fields[8]) ||
      !valid_digest(fields[9]) || !valid_digest(fields[10]) || !valid_digest(fields[11]) ||
      (strcmp(fields[2], "RESTORE_QUARANTINE") == 0
        ? strcmp(fields[12], "-") != 0 : !valid_digest(fields[12])) ||
      !valid_digest(fields[13]) ||
      !has_prefix(fields[14], ".changes-history-native-undo-final.") ||
      strlen(fields[14]) >= sizeof(request->final_name) || !valid_digest(fields[15]) ||
      !parse_identity_fields(fields, 16U, &request->final_record) ||
      !parse_uint(fields[25], MAX_ITEMS, &item_count) || item_count == 0U) return false;
  request->command = strcmp(fields[2], "RESTORE_QUARANTINE") == 0 ? 'B' : 'D';
  memcpy(request->operation, fields[3], strlen(fields[3]) + 1U);
  memcpy(request->artifact, fields[4], DIGEST_BYTES + 1U);
  memcpy(request->artifact_identity, fields[5], DIGEST_BYTES + 1U);
  memcpy(request->root_digest, fields[7], DIGEST_BYTES + 1U);
  memcpy(request->recovery_digest, fields[8], DIGEST_BYTES + 1U);
  memcpy(request->phase, fields[9], DIGEST_BYTES + 1U);
  memcpy(request->selection, fields[10], DIGEST_BYTES + 1U);
  memcpy(request->prepared_history, fields[11], DIGEST_BYTES + 1U);
  memcpy(request->history_phase, fields[12], strlen(fields[12]) + 1U);
  memcpy(request->receipt_set, fields[13], DIGEST_BYTES + 1U);
  memcpy(request->final_name, fields[14], strlen(fields[14]) + 1U);
  memcpy(request->final_digest, fields[15], DIGEST_BYTES + 1U);
  request->count = (size_t)item_count;
  return true;
}

static bool undo_ack_output(const UndoRequest *request, const char *state, const char *error) {
  char line[1024];
  int length = snprintf(line, sizeof(line), "A\tRESULT\t%s\t%s\t%s\t%s\n",
    state, request->operation, request->final_digest, error);
  return length > 0 && (size_t)length < sizeof(line) && write_line(line);
}

static bool undo_private_records_absent(RootBinding *root, const UndoRequest *request) {
  struct stat ignored;
  for (size_t i = 0U; i < request->count; i += 1U) {
    if (fstatat(root->recovery_fd, request->items[i].control_name,
          &ignored, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT ||
        fstatat(root->recovery_fd, request->items[i].receipt_name,
          &ignored, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT ||
        fstatat(root->recovery_fd, request->items[i].quarantine_name,
          &ignored, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) return false;
  }
  return fstatat(root->recovery_fd, request->final_name,
    &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
}

static bool undo_ack(RootBinding *root, UndoRequest *request) {
  char supplied_final_name[128]; char supplied_final_digest[72];
  RecordIdentity supplied_final_identity = request->final_record;
  memcpy(supplied_final_name, request->final_name, sizeof(supplied_final_name));
  memcpy(supplied_final_digest, request->final_digest, sizeof(supplied_final_digest));
  char (*controls)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*controls));
  char (*receipts)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*receipts));
  char final_record[4097];
  if (controls == NULL || receipts == NULL || !undo_authority_valid(root, request) ||
      !build_undo_final(request, final_record) ||
      strcmp(request->final_name, supplied_final_name) != 0 ||
      strcmp(request->final_digest, supplied_final_digest) != 0 ||
      !record_identity_describes_bytes(&supplied_final_identity, final_record) ||
      !undo_branch_public_state(root, request, true) ||
      !undo_namespace_clean(root->recovery_fd, request, controls, receipts,
        request->final_name, final_record)) goto unknown;
  for (size_t i = 0U; i < request->count; i += 1U) {
    UndoItem *item = &request->items[i];
    char control_name[128]; char receipt_name[128];
    char control_digest[72]; char receipt_digest[72];
    memcpy(control_name, item->control_name, sizeof(control_name));
    memcpy(receipt_name, item->receipt_name, sizeof(receipt_name));
    memcpy(control_digest, item->control_digest, sizeof(control_digest));
    memcpy(receipt_digest, item->receipt_digest, sizeof(receipt_digest));
    if (!build_undo_control(request, item, controls[i]) ||
        strcmp(item->control_name, control_name) != 0 ||
        strcmp(item->receipt_name, receipt_name) != 0 ||
        strcmp(item->control_digest, control_digest) != 0 ||
        !build_undo_receipt(request, item, receipts[i]) ||
        strcmp(item->receipt_digest, receipt_digest) != 0 ||
        !record_identity_describes_bytes(&item->control_record, controls[i]) ||
        !record_identity_describes_bytes(&item->receipt_record, receipts[i])) goto unknown;
  }
  bool all_absent = undo_private_records_absent(root, request);
  if (all_absent) {
    bool result = undo_ack_output(request, "ACKED", "-");
    free(controls); free(receipts); return result;
  }
  if (!undo_records_exact(root, request, controls, receipts) ||
      !record_identity_exact(root->recovery_fd, request->final_name, final_record,
        &supplied_final_identity)) goto unknown;
#ifdef WRITCRAFT_TEST_PAUSE_UNDO_ACK_BEFORE_CLEANUP
  if (!test_sync_point("undo-ack-before-cleanup")) goto unknown;
#endif
  if (!undo_authority_valid(root, request) ||
      !undo_records_exact(root, request, controls, receipts) ||
      !record_identity_exact(root->recovery_fd, request->final_name, final_record,
        &supplied_final_identity) || !undo_branch_public_state(root, request, true) ||
      !undo_namespace_clean(root->recovery_fd, request, controls, receipts,
        request->final_name, final_record)) goto unknown;
  for (size_t i = 0U; i < request->count; i += 1U) {
    if (!unlink_exact_record_owned(root->recovery_fd, request->items[i].receipt_name,
          receipts[i], &request->items[i].receipt_record.identity, -1) ||
        !unlink_exact_record_owned(root->recovery_fd, request->items[i].control_name,
          controls[i], &request->items[i].control_record.identity, -1)) goto unknown;
  }
  if (!unlink_exact_record_owned(root->recovery_fd, request->final_name, final_record,
      &supplied_final_identity.identity, -1)) goto unknown;
#ifdef WRITCRAFT_TEST_PAUSE_UNDO_ACK_AFTER_UNLINK
  if (!test_sync_point("undo-ack-after-unlink")) goto unknown;
#endif
  if (fsync(root->recovery_fd) != 0 ||
      !undo_private_records_absent(root, request) || !open_recovery(root, false)) goto unknown;
#ifdef WRITCRAFT_TEST_DROP_UNDO_ACK_RESPONSE
  _exit(116);
#endif
  {
    bool result = undo_ack_output(request, "ACKED", "-");
    free(controls); free(receipts); return result;
  }
unknown:
  free(controls); free(receipts);
  return undo_ack_output(request, "UNKNOWN", "UNKNOWN");
}

static bool __attribute__((unused)) rollback_append(
  char *buffer, size_t capacity, size_t *used, const char *format, ...
) {
  if (*used >= capacity) return false;
  va_list arguments;
  va_start(arguments, format);
  int length = vsnprintf(buffer + *used, capacity - *used, format, arguments);
  va_end(arguments);
  if (length < 0 || (size_t)length >= capacity - *used) return false;
  *used += (size_t)length;
  return true;
}

static bool rollback_parent_order_valid(const RollbackRequest *request) {
  bool seen[MAX_ITEMS] = { false };
  size_t previous = 0U;
  for (size_t i = 0U; i < request->existing_count; i += 1U) {
    size_t parent = request->existing[i].parent_index;
    if (parent >= request->existing_count + request->count || seen[parent] ||
        (i > 0U && parent <= previous)) return false;
    seen[parent] = true;
    previous = parent;
  }
  previous = 0U;
  for (size_t i = 0U; i < request->count; i += 1U) {
    size_t parent = request->items[i].parent_index;
    if (parent >= request->existing_count + request->count || seen[parent] ||
        (i > 0U && parent <= previous)) return false;
    seen[parent] = true;
    previous = parent;
  }
  for (size_t i = 0U; i < request->existing_count + request->count; i += 1U) {
    if (!seen[i]) return false;
  }
  return true;
}

static bool __attribute__((unused)) rollback_identity_json(
  char *buffer, size_t capacity, size_t *used, const RecordIdentity *record
) {
  const Identity *identity = &record->identity;
  if (identity->mtime_ns < 0 || identity->ctime_ns < 0) return false;
  return rollback_append(buffer, capacity, used,
    "{\"contentSha256\":\"%s\",\"ctimeNs\":\"%" PRIuMAX
    "\",\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX
    "\",\"mode\":%" PRIuMAX ",\"mtimeNs\":\"%" PRIuMAX
    "\",\"nlink\":%" PRIuMAX ",\"schema\":\"" OBJECT_SCHEMA
    "\",\"size\":\"%" PRIuMAX "\",\"uid\":%" PRIuMAX "}",
    record->content, (uintmax_t)identity->ctime_ns, identity->dev, identity->ino,
    permission_mode(identity->mode), (uintmax_t)identity->mtime_ns, identity->nlink,
    identity->size, identity->uid);
}

static bool rollback_selection_digest(const RollbackRequest *request, char out[72]) {
  char *canonical = calloc(MAX_INPUT_BYTES + 1U, 1U);
  if (canonical == NULL) return false;
  size_t used = 0U;
  bool ok = rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
    "{\"kind\":\"snapshot_restore\",\"schema\":\"" PHASE_SELECTION_SCHEMA
    "\",\"selected\":[");
  for (size_t parent = 0U; ok && parent < request->existing_count + request->count; parent += 1U) {
    const char *selected = NULL;
    const char *path = NULL;
    const char *revision = NULL;
    const char *ancestor = NULL;
    const char *action = NULL;
    for (size_t i = 0U; i < request->existing_count; i += 1U) {
      if (request->existing[i].parent_index == parent) {
        selected = request->existing[i].selected;
        path = request->existing[i].path;
        revision = request->existing[i].after_revision;
        ancestor = request->existing[i].ancestor;
        action = "EXISTING";
        break;
      }
    }
    if (selected == NULL) {
      for (size_t i = 0U; i < request->count; i += 1U) {
        if (request->items[i].parent_index == parent) {
          selected = request->items[i].create.selected;
          path = request->items[i].create.path;
          revision = request->items[i].create.content + 7U;
          ancestor = request->items[i].create.ancestor;
          action = "MISSING";
          break;
        }
      }
    }
    char escaped[MAX_PATH_BYTES * 2U + 1U];
    ok = selected != NULL && json_escape(path, escaped, sizeof(escaped)) &&
      rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
        "%s{\"action\":\"%s\",\"ancestorIdentityDigest\":\"%s\",\"path\":\"%s\""
        ",\"revision\":\"%s\",\"selectedId\":\"%s\"}",
        parent == 0U ? "" : ",", action, ancestor, escaped, revision, selected);
  }
  ok = ok && rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used, "]}") &&
    digest_domain(PHASE_SELECTION_SCHEMA, canonical, out);
  free(canonical);
  return ok;
}

static bool rollback_phase_digest(
  const RollbackRequest *request, bool created, char out[72]
) {
  char *canonical = calloc(MAX_INPUT_BYTES + 1U, 1U);
  if (canonical == NULL) return false;
  size_t used = 0U;
  bool ok = rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
    "{\"artifactDigest\":\"%s\",\"existingReceiptSetDigest\":null"
    ",\"finalReceiptDigest\":null,\"items\":[", request->create_request.artifact);
  for (size_t i = 0U; ok && i < request->count; i += 1U) {
    const RollbackItem *item = &request->items[i];
    char escaped[MAX_PATH_BYTES * 2U + 1U];
    ok = json_escape(item->create.path, escaped, sizeof(escaped)) &&
      rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
        "%s{\"afterRevision\":\"%s\",\"ancestorIdentityDigest\":\"%s\""
        ",\"createdIdentityDigest\":%s%s%s,\"creationReceiptDigest\":%s%s%s"
        ",\"path\":\"%s\",\"quarantineReceiptDigest\":null,\"selectedId\":\"%s\"}",
        i == 0U ? "" : ",", item->create.content + 7U, item->create.ancestor,
        created ? "\"" : "", created ? item->create.created_digest : "null",
        created ? "\"" : "", created ? "\"" : "",
        created ? item->create_receipt_digest : "null", created ? "\"" : "",
        escaped, item->create.selected);
  }
  ok = ok && rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
    "],\"kind\":\"snapshot_restore\",\"operationId\":\"%s\",\"phase\":\"%s\""
    ",\"preparedHistoryDigest\":%s%s%s,\"rollbackReceiptDigest\":null"
    ",\"schema\":\"" PHASE_SCHEMA "\",\"selectionDigest\":\"%s\",\"updatedAt\":\"%s\"}",
    request->create_request.operation, created ? "CREATED_RECEIPT" : "PRECREATE",
    created ? "\"" : "", created ? request->prepared_history : "null", created ? "\"" : "",
    request->create_request.selection,
    created ? request->original_updated_at : request->precreate_updated_at) &&
    digest_domain(PHASE_SCHEMA, canonical, out);
  free(canonical);
  return ok;
}

static bool rollback_create_request_digest(const RollbackRequest *request, char out[72]) {
  char *canonical = calloc(MAX_INPUT_BYTES + 1U, 1U);
  if (canonical == NULL) return false;
  size_t used = 0U;
  bool ok = rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
    "{\"artifactByteLength\":%" PRIu64 ",\"artifactDigest\":\"%s\""
    ",\"artifactIdentityDigest\":\"%s\",\"items\":[",
    request->create_request.artifact_length, request->create_request.artifact,
    request->create_request.artifact_identity);
  for (size_t i = 0U; ok && i < request->count; i += 1U) {
    const Item *item = &request->items[i].create;
    char escaped[MAX_PATH_BYTES * 2U + 1U];
    ok = json_escape(item->path, escaped, sizeof(escaped)) &&
      rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
        "%s{\"ancestorIdentityDigest\":\"%s\",\"artifactOffset\":%" PRIu64
        ",\"byteLength\":%" PRIu64 ",\"contentDigest\":\"%s\",\"path\":\"%s\""
        ",\"selectedId\":\"%s\"}", i == 0U ? "" : ",", item->ancestor,
        item->offset, item->length, item->content, escaped, item->selected);
  }
  ok = ok && rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
    "],\"operationId\":\"%s\",\"precreatePhaseDigest\":\"%s\""
    ",\"schema\":\"" CREATE_REQUEST_SCHEMA "\",\"selectionDigest\":\"%s\"}",
    request->create_request.operation, request->create_request.phase,
    request->create_request.selection) && digest_domain(CREATE_REQUEST_SCHEMA, canonical, out);
  free(canonical);
  return ok;
}

static bool rollback_create_publications_valid(RollbackRequest *request) {
  char create_digest[72];
  if (!rollback_create_request_digest(request, create_digest)) return false;
  (void)create_digest;
  for (size_t i = 0U; i < request->count; i += 1U) {
    RollbackItem *rollback = &request->items[i];
    Item rebuilt = rollback->create;
    char control[MAX_RECORD_BYTES + 1U];
    char receipt[MAX_RECORD_BYTES + 1U];
    if (!build_names_and_control(&request->create_request, &rebuilt, control) ||
        strcmp(rebuilt.control_name, rollback->create_control_name) != 0 ||
        strcmp(rebuilt.control_digest, rollback->create_control_digest) != 0 ||
        !build_receipt(&request->create_request, &rebuilt, receipt) ||
        strcmp(rebuilt.receipt_name, rollback->create_receipt_name) != 0 ||
        strcmp(rebuilt.receipt_digest, rollback->create_receipt_digest) != 0 ||
        !record_identity_describes_bytes(&rollback->create_control_record, control) ||
        !record_identity_describes_bytes(&rollback->create_receipt_record, receipt)) return false;
  }
  return true;
}

static bool rollback_rebuilt_create_authority(RollbackRequest *request) {
  char selection[72];
  char precreate[72];
  char created[72];
  return rollback_parent_order_valid(request) && rollback_selection_digest(request, selection) &&
    strcmp(selection, request->create_request.selection) == 0 &&
    rollback_phase_digest(request, false, precreate) &&
    strcmp(precreate, request->create_request.phase) == 0 &&
    rollback_phase_digest(request, true, created) && strcmp(created, request->created_phase) == 0 &&
    rollback_create_publications_valid(request);
}

static bool rollback_existing_record_names(
  const RollbackRequest *request, const RollbackExistingItem *item,
  char control[128], char apply[128], char rollback[128]
) {
  char canonical[1024];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"operationId\":\"%s\",\"requestDigest\":\"%s\",\"schema\":\""
    EXISTING_RECORD_KEY_SCHEMA "\",\"selectedId\":\"%s\"}",
    request->create_request.operation, request->existing_request, item->selected);
  char digest[72];
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(EXISTING_RECORD_KEY_SCHEMA, canonical, digest)) return false;
  int c = snprintf(control, 128U, ".changes-history-native-existing-control.%s", digest + 7U);
  int a = snprintf(apply, 128U, ".changes-history-native-existing-apply.%s", digest + 7U);
  int r = snprintf(rollback, 128U, ".changes-history-native-existing-rollback.%s", digest + 7U);
  return c > 0 && a > 0 && r > 0 && c < 128 && a < 128 && r < 128;
}

static bool rollback_existing_records(
  const RollbackRequest *request, RollbackExistingItem *item,
  char control[MAX_RECORD_BYTES + 1U], char apply[MAX_RECORD_BYTES + 1U],
  char rollback[MAX_RECORD_BYTES + 1U]
) {
  char escaped[MAX_PATH_BYTES * 2U + 1U];
  char canonical[MAX_RECORD_BYTES + 1U];
  char control_name[128];
  char apply_name[128];
  char rollback_name[128];
  char rebuilt_control[72];
  char rebuilt_apply[72];
  char rebuilt_rollback[72];
  if (!json_escape(item->path, escaped, sizeof(escaped)) ||
      !rollback_existing_record_names(request, item, control_name, apply_name, rollback_name) ||
      strcmp(control_name, item->control_name) != 0 ||
      strcmp(rollback_name, item->rollback_name) != 0) {
    DEBUG_STAGE("rollback-existing-record-names"); return false;
  }
  int length = snprintf(canonical, sizeof(canonical),
    "{\"afterArtifactOffset\":%" PRIu64 ",\"afterByteLength\":%" PRIu64
    ",\"afterContentDigest\":\"%s\",\"afterRevision\":\"%s\""
    ",\"ancestorIdentityDigest\":\"%s\",\"artifactDigest\":\"%s\""
    ",\"artifactIdentityDigest\":\"%s\",\"baseHistoryDigest\":\"%s\""
    ",\"beforeArtifactOffset\":%" PRIu64 ",\"beforeByteLength\":%" PRIu64
    ",\"beforeContentDigest\":\"%s\",\"beforeLeafIdentityDigest\":\"%s\""
    ",\"beforeRevision\":\"%s\",\"createdReceiptPhaseDigest\":\"%s\""
    ",\"markerDigest\":\"%s\",\"operationId\":\"%s\",\"path\":\"%s\""
    ",\"schema\":\"" EXISTING_CONTROL_SCHEMA "\",\"selectedId\":\"%s\""
    ",\"selectionDigest\":\"%s\"}", item->after_offset, item->after_length,
    item->after_content, item->after_revision, item->ancestor, request->create_request.artifact,
    request->create_request.artifact_identity, request->base_history, item->before_offset,
    item->before_length, item->before_content, item->before_leaf, item->before_revision,
    request->created_phase, request->marker_digest, request->create_request.operation, escaped,
    item->selected, request->create_request.selection);
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(EXISTING_CONTROL_SCHEMA, canonical, rebuilt_control) ||
      strcmp(rebuilt_control, item->control_digest) != 0) {
    DEBUG_STAGE("rollback-existing-control-digest"); return false;
  }
  char path_hex[(MAX_PATH_BYTES * 2U) + 1U];
  static const char alphabet[] = "0123456789abcdef";
  size_t path_length = strlen(item->path);
  for (size_t i = 0U; i < path_length; i += 1U) {
    unsigned char byte = (unsigned char)item->path[i];
    path_hex[i * 2U] = alphabet[byte >> 4U];
    path_hex[i * 2U + 1U] = alphabet[byte & 0x0fU];
  }
  path_hex[path_length * 2U] = '\0';
  length = snprintf(control, MAX_RECORD_BYTES + 1U,
    EXISTING_CONTROL_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s"
    "\t%" PRIu64 "\t%" PRIu64 "\t%s\t%" PRIu64 "\t%" PRIu64 "\t%s\t%s\t%s\t%s\n",
    request->create_request.operation, item->selected, path_hex, request->marker_digest,
    request->create_request.artifact, request->create_request.artifact_identity,
    request->created_phase, request->create_request.selection, request->base_history,
    item->before_revision, item->after_revision, item->before_offset, item->before_length,
    item->before_content, item->after_offset, item->after_length, item->after_content,
    item->ancestor, item->before_leaf, item->control_digest);
  if (length <= 0 || length > (int)MAX_RECORD_BYTES) return false;
  if (item->has_apply) {
    length = snprintf(canonical, sizeof(canonical),
      "{\"afterContentDigest\":\"%s\",\"afterLeafIdentityDigest\":\"%s\""
      ",\"controlDigest\":\"%s\",\"fileFsyncComplete\":true,\"operationId\":\"%s\""
      ",\"parentFsyncComplete\":true,\"recoveryFsyncComplete\":true,\"schema\":\""
      EXISTING_APPLY_SCHEMA "\",\"selectedId\":\"%s\"}", item->after_content,
      item->after_leaf, item->control_digest, request->create_request.operation, item->selected);
    if (length <= 0 || (size_t)length >= sizeof(canonical) ||
        !digest_domain(EXISTING_APPLY_SCHEMA, canonical, rebuilt_apply) ||
        strcmp(rebuilt_apply, item->apply_digest) != 0) return false;
    length = snprintf(apply, MAX_RECORD_BYTES + 1U,
      EXISTING_APPLY_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t1\t1\t1\t%s\n",
      request->create_request.operation, item->selected, item->control_digest,
      item->after_content, item->after_leaf, item->apply_digest);
    if (length <= 0 || length > (int)MAX_RECORD_BYTES) return false;
  } else apply[0] = '\0';
  length = snprintf(canonical, sizeof(canonical),
    "{\"applyReceiptDigest\":%s%s%s,\"beforeContentDigest\":\"%s\""
    ",\"controlDigest\":\"%s\",\"fileFsyncComplete\":true,\"operationId\":\"%s\""
    ",\"parentFsyncComplete\":true,\"recoveryFsyncComplete\":true"
    ",\"restoredLeafIdentityDigest\":\"%s\",\"schema\":\""
    EXISTING_ROLLBACK_SCHEMA "\",\"selectedId\":\"%s\"}",
    item->has_apply ? "\"" : "", item->has_apply ? item->apply_digest : "null",
    item->has_apply ? "\"" : "", item->before_content, item->control_digest,
    request->create_request.operation, item->restored_leaf, item->selected);
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(EXISTING_ROLLBACK_SCHEMA, canonical, rebuilt_rollback) ||
      strcmp(rebuilt_rollback, item->rollback_digest) != 0) {
    DEBUG_STAGE("rollback-existing-rollback-digest"); return false;
  }
  length = snprintf(rollback, MAX_RECORD_BYTES + 1U,
    EXISTING_ROLLBACK_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%s\t1\t1\t1\t%s\n",
    request->create_request.operation, item->selected, item->control_digest,
    item->has_apply ? item->apply_digest : "-", item->before_content,
    item->restored_leaf, item->rollback_digest);
  return length > 0 && length <= (int)MAX_RECORD_BYTES;
}

static bool rollback_append_existing_apply_token(
  char *buffer, size_t capacity, size_t *used, const RollbackRequest *request,
  const RollbackExistingItem *item
) {
  char control[128];
  char apply[128];
  char rollback[128];
  if (!item->has_apply ||
      !rollback_existing_record_names(request, item, control, apply, rollback)) return false;
  return rollback_append(buffer, capacity, used,
    "{\"afterLeafIdentityDigest\":\"%s\",\"applyReceiptDigest\":\"%s\""
    ",\"controlBasename\":\"%s\",\"controlDigest\":\"%s\""
    ",\"controlRecordIdentity\":", item->after_leaf, item->apply_digest, control,
    item->control_digest) && rollback_identity_json(buffer, capacity, used, &item->control_record) &&
    rollback_append(buffer, capacity, used, ",\"receiptBasename\":\"%s\""
      ",\"receiptRecordIdentity\":", apply) &&
    rollback_identity_json(buffer, capacity, used, &item->apply_record) &&
    rollback_append(buffer, capacity, used, ",\"schema\":\""
      EXISTING_APPLY_TOKEN_SCHEMA "\",\"selectedId\":\"%s\"}", item->selected);
}

static bool rollback_append_existing_rollback_token(
  char *buffer, size_t capacity, size_t *used, const RollbackRequest *request,
  const RollbackExistingItem *item
) {
  char control[128];
  char apply[128];
  char rollback[128];
  if (!rollback_existing_record_names(request, item, control, apply, rollback) ||
      !rollback_append(buffer, capacity, used,
        "{\"afterLeafIdentityDigest\":%s%s%s,\"applyReceiptDigest\":%s%s%s"
        ",\"applyReceiptRecordIdentity\":", item->has_apply ? "\"" : "",
        item->has_apply ? item->after_leaf : "null", item->has_apply ? "\"" : "",
        item->has_apply ? "\"" : "", item->has_apply ? item->apply_digest : "null",
        item->has_apply ? "\"" : "")) return false;
  if (item->has_apply) {
    if (!rollback_identity_json(buffer, capacity, used, &item->apply_record)) return false;
  } else if (!rollback_append(buffer, capacity, used, "null")) return false;
  if (!rollback_append(buffer, capacity, used,
      ",\"controlBasename\":\"%s\",\"controlDigest\":\"%s\""
      ",\"controlRecordIdentity\":", control, item->control_digest) ||
      !rollback_identity_json(buffer, capacity, used, &item->control_record) ||
      !rollback_append(buffer, capacity, used,
        ",\"receiptBasename\":\"%s\",\"restoredLeafIdentityDigest\":\"%s\""
        ",\"rollbackReceiptDigest\":\"%s\",\"rollbackReceiptRecordIdentity\":",
        rollback, item->restored_leaf, item->rollback_digest) ||
      !rollback_identity_json(buffer, capacity, used, &item->rollback_record) ||
      !rollback_append(buffer, capacity, used, ",\"schema\":\""
        EXISTING_ROLLBACK_TOKEN_SCHEMA "\",\"selectedId\":\"%s\"}", item->selected)) {
    return false;
  }
  return true;
}

static bool rollback_append_existing_terminal_items(
  char *buffer, size_t capacity, size_t *used, const RollbackRequest *request
) {
  for (size_t i = 0U; i < request->existing_count; i += 1U) {
    const RollbackExistingItem *item = &request->existing[i];
    if (!rollback_append(buffer, capacity, used, "%s{\"applyToken\":",
        i == 0U ? "" : ",")) return false;
    if (item->has_apply) {
      if (!rollback_append_existing_apply_token(buffer, capacity, used, request, item)) return false;
    } else if (!rollback_append(buffer, capacity, used, "null")) return false;
    if (!rollback_append(buffer, capacity, used, ",\"finalContentDigest\":\"%s\""
        ",\"finalLeafIdentityDigest\":\"%s\",\"rollbackToken\":",
        item->before_content, item->restored_leaf) ||
        !rollback_append_existing_rollback_token(buffer, capacity, used, request, item) ||
        !rollback_append(buffer, capacity, used, ",\"selectedId\":\"%s\"}",
          item->selected)) return false;
  }
  return true;
}

static bool rollback_existing_terminal_valid(RollbackRequest *request) {
  /* The EXISTING request digest is anchored through the on-disk record names:
   * rollback_existing_records derives each control/rollback basename from
   * request->existing_request (recordKey) and verifies the record files at
   * those names with exact content identities. The E/R path never recomputes
   * the request digest either; the legacy rollback rebuild predates the
   * WRCCHRJ2 journal binding, which is not carried on the rollback wire, so
   * the on-disk record anchor plus the held-journal whole-content sha
   * (journal_digest) are the single-authority bindings here. */
  char (*controls)[MAX_RECORD_BYTES + 1U] = calloc(request->existing_count, sizeof(*controls));
  char (*applies)[MAX_RECORD_BYTES + 1U] = calloc(request->existing_count, sizeof(*applies));
  char (*rollbacks)[MAX_RECORD_BYTES + 1U] = calloc(request->existing_count, sizeof(*rollbacks));
  char *canonical = calloc(MAX_INPUT_BYTES + 1U, 1U);
  if (controls == NULL || applies == NULL || rollbacks == NULL || canonical == NULL) {
    free(controls); free(applies); free(rollbacks); free(canonical); return false;
  }
  bool ok = true;
  for (size_t i = 0U; ok && i < request->existing_count; i += 1U) {
    RollbackExistingItem *item = &request->existing[i];
    ok = rollback_existing_records(request, item, controls[i], applies[i], rollbacks[i]) &&
      record_identity_describes_bytes(&item->control_record, controls[i]) &&
      (!item->has_apply || record_identity_describes_bytes(&item->apply_record, applies[i])) &&
      record_identity_describes_bytes(&item->rollback_record, rollbacks[i]);
  }
  if (!ok) DEBUG_STAGE("rollback-existing-records");
  size_t used = 0U;
  if (ok) ok = rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used, "{\"items\":[") &&
    rollback_append_existing_terminal_items(canonical, MAX_INPUT_BYTES + 1U, &used, request) &&
    rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
      "],\"operationId\":\"%s\",\"requestDigest\":\"%s\",\"schema\":\""
      EXISTING_TERMINAL_SCHEMA "\",\"state\":\"UNCOMMITTED\"}",
      request->create_request.operation, request->existing_request);
  char receipt_set[72];
  if (ok) ok = digest_domain(EXISTING_TERMINAL_SCHEMA, canonical, receipt_set) &&
    strcmp(receipt_set, request->existing_receipt_set) == 0;
  if (!ok) DEBUG_STAGE("rollback-existing-receipt-set");
  used = 0U;
  if (ok) ok = rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
    "{\"artifactDigest\":\"%s\",\"baseHistoryDigest\":\"%s\""
    ",\"createdReceiptPhaseDigest\":\"%s\",\"items\":[",
    request->create_request.artifact, request->base_history, request->created_phase) &&
    rollback_append_existing_terminal_items(canonical, MAX_INPUT_BYTES + 1U, &used, request) &&
    rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
      "],\"markerDigest\":\"%s\",\"operationId\":\"%s\""
      ",\"receiptSetDigest\":\"%s\",\"recoveryFsyncComplete\":true"
      ",\"schema\":\"" EXISTING_TERMINAL_SCHEMA "\",\"selectionDigest\":\"%s\""
      ",\"state\":\"UNCOMMITTED\"}", request->marker_digest,
      request->create_request.operation, request->existing_receipt_set,
      request->create_request.selection);
  char terminal[72];
  if (ok) ok = digest_domain(EXISTING_TERMINAL_SCHEMA, canonical, terminal) &&
    strcmp(terminal, request->existing_terminal) == 0;
  if (!ok) DEBUG_STAGE("rollback-existing-terminal-digest");
  free(controls); free(applies); free(rollbacks); free(canonical);
  return ok;
}

static bool rollback_request_digest_valid(const RollbackRequest *request) {
  char *canonical = calloc(MAX_INPUT_BYTES + 1U, 1U);
  if (canonical == NULL) return false;
  size_t used = 0U;
  bool ok = rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
    "{\"artifactByteLength\":%" PRIu64 ",\"artifactDigest\":\"%s\""
    ",\"artifactIdentityDigest\":\"%s\",\"baseHistoryByteLength\":%" PRIu64
    ",\"baseHistoryContentDigest\":%s%s%s,\"baseHistoryDigest\":\"%s\""
    ",\"baseHistoryExists\":%s,\"baseHistoryIdentityDigest\":%s%s%s"
    ",\"createPrecreatePhaseDigest\":\"%s\",\"createdReceiptPhaseDigest\":\"%s\""
    ",\"existingReceiptSetDigest\":\"%s\",\"existingRequestDigest\":\"%s\""
    ",\"existingTerminalReceiptDigest\":\"%s\",\"historyParentIdentityDigest\":\"%s\""
    ",\"items\":[", request->create_request.artifact_length,
    request->create_request.artifact, request->create_request.artifact_identity,
    request->base_history_length, request->base_history_exists ? "\"" : "",
    request->base_history_exists ? request->base_history_content : "null",
    request->base_history_exists ? "\"" : "", request->base_history,
    request->base_history_exists ? "true" : "false", request->base_history_exists ? "\"" : "",
    request->base_history_exists ? request->base_history_identity : "null",
    request->base_history_exists ? "\"" : "", request->create_request.phase,
    request->created_phase, request->existing_receipt_set, request->existing_request,
    request->existing_terminal, request->history_parent);
  for (size_t i = 0U; ok && i < request->count; i += 1U) {
    const RollbackItem *item = &request->items[i];
    char escaped[MAX_PATH_BYTES * 2U + 1U];
    ok = json_escape(item->create.path, escaped, sizeof(escaped)) &&
      rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
        "%s{\"ancestorIdentityDigest\":\"%s\",\"artifactOffset\":%" PRIu64
        ",\"byteLength\":%" PRIu64 ",\"contentDigest\":\"%s\""
        ",\"createControlBasename\":\"%s\",\"createControlDigest\":\"%s\""
        ",\"createControlRecordIdentity\":", i == 0U ? "" : ",", item->create.ancestor,
        item->create.offset, item->create.length, item->create.content,
        item->create_control_name, item->create_control_digest) &&
      rollback_identity_json(canonical, MAX_INPUT_BYTES + 1U, &used,
        &item->create_control_record) &&
      rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
        ",\"createReceiptBasename\":\"%s\",\"createReceiptDigest\":\"%s\""
        ",\"createReceiptRecordIdentity\":", item->create_receipt_name,
        item->create_receipt_digest) &&
      rollback_identity_json(canonical, MAX_INPUT_BYTES + 1U, &used,
        &item->create_receipt_record) &&
      rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
        ",\"createdIdentityDigest\":\"%s\",\"path\":\"%s\",\"selectedId\":\"%s\"}",
        item->create.created_digest, escaped, item->create.selected);
  }
  ok = ok && rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
    "],\"journalMarkerDigest\":\"%s\",\"markerByteLength\":%" PRIu64
    ",\"markerDigest\":\"%s\""
    ",\"markerIdentityDigest\":\"%s\",\"operationId\":\"%s\""
    ",\"originalCreatedReceiptUpdatedAt\":\"%s\",\"originalPrecreateUpdatedAt\":\"%s\""
    ",\"preparedHistoryDigest\":\"%s\",\"recoveryIdentityDigest\":\"%s\""
    ",\"rootIdentityDigest\":\"%s\",\"schema\":\"" ROLLBACK_REQUEST_SCHEMA
    "\",\"selectionDigest\":\"%s\"}", request->journal_digest, request->marker_length,
    request->marker_digest, request->marker_identity, request->create_request.operation,
    request->original_updated_at, request->precreate_updated_at, request->prepared_history,
    request->recovery_digest, request->root_digest, request->create_request.selection);
  char digest[72];
  ok = ok && digest_domain(ROLLBACK_REQUEST_SCHEMA, canonical, digest) &&
    strcmp(digest, request->request_digest) == 0;
  free(canonical);
  return ok;
}

static bool rollback_record_names(
  const RollbackRequest *request, const RollbackItem *item, char control[128], char receipt[128]
) {
  char canonical[1024];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"operationId\":\"%s\",\"requestDigest\":\"%s\",\"schema\":\""
    ROLLBACK_RECORD_KEY_SCHEMA "\",\"selectedId\":\"%s\"}",
    request->create_request.operation, request->request_digest, item->create.selected);
  char digest[72];
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(ROLLBACK_RECORD_KEY_SCHEMA, canonical, digest)) return false;
  int c = snprintf(control, 128U,
    ".changes-history-native-rollback-create-control.%s", digest + 7U);
  int r = snprintf(receipt, 128U,
    ".changes-history-native-rollback-create-receipt.%s", digest + 7U);
  return c > 0 && r > 0 && c < 128 && r < 128;
}

static bool rollback_build_control(
  const RollbackRequest *request, RollbackItem *item, char out[MAX_RECORD_BYTES + 1U]
) {
  char expected_control[128];
  char expected_receipt[128];
  if (!rollback_record_names(request, item, expected_control, expected_receipt)) return false;
  memcpy(item->quarantine.control_name, expected_control, strlen(expected_control) + 1U);
  memcpy(item->quarantine.receipt_name, expected_receipt, strlen(expected_receipt) + 1U);
  char escaped[MAX_PATH_BYTES * 2U + 1U];
  if (!json_escape(item->create.path, escaped, sizeof(escaped))) return false;
  char canonical[MAX_RECORD_BYTES + 1U];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"ancestorIdentityDigest\":\"%s\",\"contentDigest\":\"%s\""
    ",\"createControlDigest\":\"%s\",\"createReceiptDigest\":\"%s\""
    ",\"createdIdentityDigest\":\"%s\",\"operationId\":\"%s\",\"path\":\"%s\""
    ",\"quarantineBasename\":\"%s\",\"requestDigest\":\"%s\",\"schema\":\""
    ROLLBACK_CONTROL_SCHEMA "\",\"selectedId\":\"%s\"}", item->create.ancestor,
    item->create.content, item->create_control_digest, item->create_receipt_digest,
    item->create.created_digest, request->create_request.operation, escaped,
    item->quarantine.quarantine_name, request->request_digest, item->create.selected);
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(ROLLBACK_CONTROL_SCHEMA, canonical, item->quarantine.control_digest)) return false;
  char path_hex[(MAX_PATH_BYTES * 2U) + 1U];
  static const char alphabet[] = "0123456789abcdef";
  size_t path_length = strlen(item->create.path);
  for (size_t i = 0U; i < path_length; i += 1U) {
    unsigned char byte = (unsigned char)item->create.path[i];
    path_hex[i * 2U] = alphabet[byte >> 4U];
    path_hex[i * 2U + 1U] = alphabet[byte & 0x0fU];
  }
  path_hex[path_length * 2U] = '\0';
  length = snprintf(out, MAX_RECORD_BYTES + 1U,
    ROLLBACK_CONTROL_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
    request->create_request.operation, item->create.selected, request->request_digest, path_hex,
    item->create.content, item->create.ancestor, item->create.created_digest,
    item->create_control_digest, item->create_receipt_digest,
    item->quarantine.quarantine_name, item->quarantine.control_digest);
  return length > 0 && length <= (int)MAX_RECORD_BYTES;
}

static bool rollback_build_receipt(
  const RollbackRequest *request, RollbackItem *item, char out[MAX_RECORD_BYTES + 1U]
) {
  char canonical[4096];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"byteLength\":%" PRIu64 ",\"contentDigest\":\"%s\""
    ",\"controlDigest\":\"%s\",\"createdIdentityDigest\":\"%s\""
    ",\"operationId\":\"%s\",\"publicParentFsyncComplete\":true"
    ",\"quarantineBasename\":\"%s\",\"quarantineIdentityDigest\":\"%s\""
    ",\"recoveryFsyncComplete\":true,\"schema\":\"" ROLLBACK_RECEIPT_SCHEMA
    "\",\"selectedId\":\"%s\"}", item->create.length, item->create.content,
    item->quarantine.control_digest, item->create.created_digest,
    request->create_request.operation, item->quarantine.quarantine_name,
    item->quarantine.quarantine_digest, item->create.selected);
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(ROLLBACK_RECEIPT_SCHEMA, canonical, item->quarantine.receipt_digest)) return false;
  length = snprintf(out, MAX_RECORD_BYTES + 1U,
    ROLLBACK_RECEIPT_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%" PRIu64
    "\t1\t1\t%s\n", request->create_request.operation, item->create.selected,
    item->quarantine.control_digest, item->quarantine.quarantine_name,
    item->create.created_digest, item->quarantine.quarantine_digest, item->create.content,
    item->create.length, item->quarantine.receipt_digest);
  return length > 0 && length <= (int)MAX_RECORD_BYTES;
}

static bool rollback_output(const RollbackRequest *request, const char *state, const char *error) {
  char line[MAX_LINE_BYTES + 1U];
  size_t token_count = strcmp(state, "COMMITTED") == 0 ? request->count : 0U;
  int length = snprintf(line, sizeof(line), "%c\tRESULT\t%s\t%s\t%s\t%zu\t%s\n",
    request->command, state, request->create_request.operation, request->request_digest,
    token_count, error);
  if (length <= 0 || (size_t)length >= sizeof(line) || !write_line(line)) return false;
  for (size_t i = 0U; i < token_count; i += 1U) {
    const UndoItem *item = &request->items[i].quarantine;
    size_t used = (size_t)snprintf(line, sizeof(line),
      "K\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s", item->selected,
      item->control_name, item->receipt_name, item->quarantine_name, item->control_digest,
      item->created, item->quarantine_digest, item->content, item->receipt_digest);
    if (used >= sizeof(line) || !append_identity(line, sizeof(line), &used,
        &item->control_record) || !append_identity(line, sizeof(line), &used,
        &item->receipt_record) || used + 2U > sizeof(line)) return false;
    line[used++] = '\n'; line[used] = '\0';
    if (!write_line(line)) return false;
  }
  return true;
}

static bool rollback_namespace_clean(
  int directory, const RollbackRequest *request,
  const char (*controls)[MAX_RECORD_BYTES + 1U],
  const char (*receipts)[MAX_RECORD_BYTES + 1U]
) {
  int scan_fd = dup(directory);
  if (scan_fd < 0) return false;
  DIR *stream = fdopendir(scan_fd);
  if (stream == NULL) { (void)close(scan_fd); return false; }
  bool clean = true;
  size_t entries = 0U;
  while (true) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (entry == NULL) { if (errno != 0) clean = false; break; }
    const char *name = entry->d_name;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
    entries += 1U;
    if (entries > MAX_RECOVERY_ENTRIES) { clean = false; break; }
    bool rollback_name =
      has_prefix(name, ".changes-history-native-rollback-create-control.") ||
      has_prefix(name, ".changes-history-native-rollback-create-receipt.") ||
      has_prefix(name, ".changes-history-native-rollback-create-quarantine.") ||
      has_prefix(name, ".changes-history-native-rollback-create-final.");
    if (!rollback_name) continue;
    bool expected = false;
    for (size_t i = 0U; i < request->count && !expected; i += 1U) {
      const UndoItem *item = &request->items[i].quarantine;
      expected = (item->control_name[0] != '\0' && strcmp(name, item->control_name) == 0) ||
        (item->receipt_name[0] != '\0' && strcmp(name, item->receipt_name) == 0) ||
        (item->quarantine_name[0] != '\0' && strcmp(name, item->quarantine_name) == 0);
    }
    if (expected) continue;
    char bytes[MAX_RECORD_BYTES + 1U];
    if (read_namespace_record(directory, name, bytes)) {
      for (size_t i = 0U; i < request->count && clean; i += 1U) {
        if ((controls != NULL && controls[i][0] != '\0' && strcmp(bytes, controls[i]) == 0) ||
            (receipts != NULL && receipts[i][0] != '\0' && strcmp(bytes, receipts[i]) == 0)) {
          clean = false;
          break;
        }
        char prefix[512];
        int length = snprintf(prefix, sizeof(prefix), ROLLBACK_CONTROL_SCHEMA "\t%s\t%s\t",
          request->create_request.operation, request->items[i].create.selected);
        if (length <= 0 || (size_t)length >= sizeof(prefix) || has_prefix(bytes, prefix)) {
          clean = false;
          break;
        }
        length = snprintf(prefix, sizeof(prefix), ROLLBACK_RECEIPT_SCHEMA "\t%s\t%s\t",
          request->create_request.operation, request->items[i].create.selected);
        if (length <= 0 || (size_t)length >= sizeof(prefix) || has_prefix(bytes, prefix)) {
          clean = false;
          break;
        }
        length = snprintf(prefix, sizeof(prefix), ROLLBACK_FINAL_SCHEMA "\t%s\t",
          request->create_request.operation);
        if (length <= 0 || (size_t)length >= sizeof(prefix) || has_prefix(bytes, prefix)) {
          clean = false;
          break;
        }
      }
    } else if (has_prefix(name, ".changes-history-native-rollback-create-quarantine.")) {
      int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
      if (fd >= 0) {
        Identity identity;
        char content[72];
        if (hash_fd(fd, &identity, content, MAX_ARTIFACT_BYTES)) {
          for (size_t i = 0U; i < request->count; i += 1U) {
            if (strcmp(content, request->items[i].create.content) == 0) {
              clean = false;
              break;
            }
          }
        }
        (void)close(fd);
      }
    }
    if (!clean) break;
  }
  (void)closedir(stream);
  return clean;
}

static bool rollback_q_state_exact(
  RootBinding *root, RollbackRequest *request, size_t moved_count,
  const char (*controls)[MAX_RECORD_BYTES + 1U],
  const char (*receipts)[MAX_RECORD_BYTES + 1U]
);

static bool rollback_quarantine_one(
  RootBinding *root, RollbackRequest *request, size_t index,
  const char (*controls)[MAX_RECORD_BYTES + 1U],
  const char (*receipts)[MAX_RECORD_BYTES + 1U]
) {
  UndoItem *item = &request->items[index].quarantine;
  Ancestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  for (size_t x = 0U; x < MAX_ROOT_COMPONENTS; x += 1U) ancestors[x].fd = -1;
  size_t depth = 0U;
  int parent = -1;
  int leaf_fd = -1;
  char leaf[MAX_PATH_BYTES + 1U];
  Identity public_identity;
  NameState state = undo_public_state(root, item, &public_identity, &leaf_fd,
    &parent, ancestors, &depth, leaf);
  if (state != NAME_EXACT) {
    if (leaf_fd >= 0) (void)close(leaf_fd);
    close_parent(ancestors, depth, parent);
    return false;
  }
  struct stat ignored;
  bool moved = fstatat(root->recovery_fd, item->quarantine_name,
      &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT &&
    rollback_q_state_exact(root, request, index, controls, receipts) &&
    record_path_matches_fd(parent, leaf, leaf_fd) &&
    renameatx_np(parent, leaf, root->recovery_fd, item->quarantine_name, RENAME_EXCL) == 0;
  if (!moved) {
    (void)close(leaf_fd); close_parent(ancestors, depth, parent); return false;
  }
  bool public_absent = fstatat(parent, leaf, &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
  int quarantine_fd = openat(root->recovery_fd, item->quarantine_name,
    O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity quarantine_identity;
  char content[72];
  char quarantine_digest[72];
  bool valid = public_absent && quarantine_fd >= 0 &&
    hash_fd(quarantine_fd, &quarantine_identity, content, item->length) &&
    same_bound_record(&public_identity, &quarantine_identity) &&
    strcmp(content, item->content) == 0 &&
    record_path_matches_fd(root->recovery_fd, item->quarantine_name, quarantine_fd) &&
    revalidate_parent(root, ancestors, depth) &&
    object_identity_digest(&quarantine_identity, content, quarantine_digest);
  if (quarantine_fd >= 0) (void)close(quarantine_fd);
  (void)close(leaf_fd);
  if (!valid || fsync(parent) != 0 || fsync(root->recovery_fd) != 0 ||
      !open_recovery(root, false)) {
    close_parent(ancestors, depth, parent); return false;
  }
  memcpy(item->quarantine_digest, quarantine_digest, DIGEST_BYTES + 1U);
  close_parent(ancestors, depth, parent);
  return true;
}

static bool rollback_held_authority(RootBinding *root, RollbackRequest *request);

static bool rollback_existing_public_exact(
  RootBinding *root, const RollbackExistingItem *item
) {
  Ancestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  for (size_t i = 0U; i < MAX_ROOT_COMPONENTS; i += 1U) ancestors[i].fd = -1;
  size_t depth = 0U;
  int parent = -1;
  char leaf[MAX_PATH_BYTES + 1U];
  char ancestor[72];
  if (!open_parent(root, item->path, ancestors, &depth, &parent, leaf, ancestor) ||
      strcmp(ancestor, item->ancestor) != 0 || !revalidate_parent(root, ancestors, depth)) {
    close_parent(ancestors, depth, parent); return false;
  }
  int fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity identity;
  char content[72];
  char escaped[MAX_PATH_BYTES * 2U + 1U];
  char canonical[MAX_RECORD_BYTES + 1U];
  char digest[72];
  bool valid = fd >= 0 && hash_fd(fd, &identity, content, item->before_length) &&
    identity.nlink == 1U && identity.size == item->before_length &&
    strcmp(content, item->before_content) == 0 &&
    record_path_matches_fd(parent, leaf, fd) && revalidate_parent(root, ancestors, depth) &&
    json_escape(item->path, escaped, sizeof(escaped));
  if (valid) {
    int length = snprintf(canonical, sizeof(canonical),
      "{\"ancestorIdentityDigest\":\"%s\",\"contentSha256\":\"%s\""
      ",\"ctimeNs\":\"%" PRIuMAX "\",\"dev\":\"%" PRIuMAX
      "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX
      ",\"mtimeNs\":\"%" PRIuMAX "\",\"nlink\":%" PRIuMAX
      ",\"path\":\"%s\",\"revision\":\"%s\",\"schema\":\""
      EXISTING_LEAF_SCHEMA "\",\"selectedId\":\"%s\",\"size\":\"%" PRIuMAX
      "\",\"uid\":%" PRIuMAX "}", item->ancestor, content,
      (uintmax_t)identity.ctime_ns, identity.dev, identity.ino,
      permission_mode(identity.mode), (uintmax_t)identity.mtime_ns, identity.nlink,
      escaped, item->before_revision, item->selected, identity.size, identity.uid);
    valid = length > 0 && (size_t)length < sizeof(canonical) &&
      digest_domain(EXISTING_LEAF_SCHEMA, canonical, digest) &&
      strcmp(digest, item->restored_leaf) == 0;
  }
  if (fd >= 0) (void)close(fd);
  close_parent(ancestors, depth, parent);
  return valid;
}

static bool rollback_private_authority_exact(RootBinding *root, RollbackRequest *request) {
  for (size_t i = 0U; i < request->count; i += 1U) {
    RollbackItem *item = &request->items[i];
    Item rebuilt = item->create;
    char control[MAX_RECORD_BYTES + 1U];
    char receipt[MAX_RECORD_BYTES + 1U];
    if (!build_names_and_control(&request->create_request, &rebuilt, control) ||
        !build_receipt(&request->create_request, &rebuilt, receipt) ||
        !record_identity_exact(root->recovery_fd, item->create_control_name, control,
          &item->create_control_record) ||
        !record_identity_exact(root->recovery_fd, item->create_receipt_name, receipt,
          &item->create_receipt_record)) return false;
  }
  for (size_t i = 0U; i < request->existing_count; i += 1U) {
    RollbackExistingItem *item = &request->existing[i];
    char control[MAX_RECORD_BYTES + 1U];
    char apply[MAX_RECORD_BYTES + 1U];
    char rollback[MAX_RECORD_BYTES + 1U];
    char control_name[128];
    char apply_name[128];
    char rollback_name[128];
    if (!rollback_existing_records(request, item, control, apply, rollback) ||
        !rollback_existing_record_names(request, item, control_name, apply_name, rollback_name) ||
        !record_identity_exact(root->recovery_fd, item->control_name, control,
          &item->control_record) ||
        (item->has_apply && !record_identity_exact(root->recovery_fd,
          apply_name, apply, &item->apply_record)) ||
        !record_identity_exact(root->recovery_fd, item->rollback_name, rollback,
          &item->rollback_record) || !rollback_existing_public_exact(root, item)) return false;
  }
  return true;
}

static bool rollback_missing_public_state(
  RootBinding *root, RollbackItem *item, NameState expected
);

static bool rollback_q_state_exact(
  RootBinding *root, RollbackRequest *request, size_t moved_count,
  const char (*controls)[MAX_RECORD_BYTES + 1U],
  const char (*receipts)[MAX_RECORD_BYTES + 1U]
) {
  if (!rollback_held_authority(root, request) ||
      !rollback_private_authority_exact(root, request) ||
      !rollback_namespace_clean(root->recovery_fd, request, controls, receipts)) {
    return false;
  }
  for (size_t i = 0U; i < request->count; i += 1U) {
    RollbackItem *item = &request->items[i];
    if (!record_identity_exact(root->recovery_fd, item->quarantine.control_name,
        controls[i], &item->quarantine.control_record)) return false;
    if (i < moved_count) {
      Identity identity;
      if (!record_identity_exact(root->recovery_fd, item->quarantine.receipt_name,
          receipts[i], &item->quarantine.receipt_record) ||
          undo_quarantine_state(root, &item->quarantine, &identity) != NAME_EXACT ||
          !rollback_missing_public_state(root, item, NAME_ABSENT)) return false;
    } else {
      struct stat ignored;
      if (fstatat(root->recovery_fd, item->quarantine.receipt_name,
            &ignored, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT ||
          fstatat(root->recovery_fd, item->quarantine.quarantine_name,
            &ignored, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT ||
          !rollback_missing_public_state(root, item, NAME_EXACT)) return false;
    }
  }
  return true;
}

static bool rollback_uncommitted_pass(RootBinding *root, RollbackRequest *request) {
  if (!rollback_held_authority(root, request) ||
      !rollback_private_authority_exact(root, request) ||
      !rollback_namespace_clean(root->recovery_fd, request, NULL, NULL)) return false;
  for (size_t i = 0U; i < request->count; i += 1U) {
    RollbackItem *item = &request->items[i];
    struct stat ignored;
    if (fstatat(root->recovery_fd, item->quarantine.control_name,
          &ignored, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT ||
        fstatat(root->recovery_fd, item->quarantine.receipt_name,
          &ignored, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT ||
        !rollback_missing_public_state(root, item, NAME_EXACT)) return false;
  }
  return true;
}

static bool rollback_uncommitted_exact(RootBinding *root, RollbackRequest *request) {
  return rollback_uncommitted_pass(root, request) && fsync(root->recovery_fd) == 0 &&
    open_recovery(root, false) && rollback_uncommitted_pass(root, request);
}

static bool rollback_missing_public_state(
  RootBinding *root, RollbackItem *item, NameState expected
) {
  Ancestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  for (size_t x = 0U; x < MAX_ROOT_COMPONENTS; x += 1U) ancestors[x].fd = -1;
  size_t depth = 0U;
  int parent = -1;
  int fd = -1;
  char leaf[MAX_PATH_BYTES + 1U];
  Identity identity;
  NameState state = undo_public_state(root, &item->quarantine, &identity, &fd,
    &parent, ancestors, &depth, leaf);
  if (fd >= 0) (void)close(fd);
  close_parent(ancestors, depth, parent);
  return state == expected;
}

static bool rollback_load_records(
  RootBinding *root, RollbackRequest *request, RollbackItem *item,
  char control[MAX_RECORD_BYTES + 1U], char receipt[MAX_RECORD_BYTES + 1U]
) {
  char control_name[128];
  char receipt_name[128];
  char bytes[MAX_RECORD_BYTES + 1U];
  if (!rollback_record_names(request, item, control_name, receipt_name) ||
      !read_namespace_record(root->recovery_fd, control_name, bytes)) return false;
  char copy[MAX_RECORD_BYTES + 1U];
  memcpy(copy, bytes, strlen(bytes) + 1U);
  if (copy[strlen(copy) - 1U] != '\n') return false;
  copy[strlen(copy) - 1U] = '\0';
  char *fields[13];
  size_t count = 0U;
  if (!split_fields(copy, fields, 13U, &count) || count != 12U ||
      strcmp(fields[0], ROLLBACK_CONTROL_SCHEMA) != 0 ||
      strcmp(fields[1], request->create_request.operation) != 0 ||
      strcmp(fields[2], item->create.selected) != 0 ||
      strcmp(fields[3], request->request_digest) != 0 ||
      !has_prefix(fields[10], ".changes-history-native-rollback-create-quarantine.") ||
      strlen(fields[10]) != strlen(".changes-history-native-rollback-create-quarantine.") + 32U) {
    return false;
  }
  memcpy(item->quarantine.quarantine_name, fields[10], strlen(fields[10]) + 1U);
  if (!rollback_build_control(request, item, control) || strcmp(control, bytes) != 0 ||
      strcmp(item->quarantine.control_digest, fields[11]) != 0 ||
      !capture_record_identity(root->recovery_fd, control_name, control,
        &item->quarantine.control_record) ||
      !read_namespace_record(root->recovery_fd, receipt_name, bytes)) return false;
  memcpy(copy, bytes, strlen(bytes) + 1U);
  if (copy[strlen(copy) - 1U] != '\n') return false;
  copy[strlen(copy) - 1U] = '\0';
  char *receipt_fields[13];
  count = 0U;
  uint64_t length;
  if (!split_fields(copy, receipt_fields, 13U, &count) || count != 12U ||
      strcmp(receipt_fields[0], ROLLBACK_RECEIPT_SCHEMA) != 0 ||
      strcmp(receipt_fields[1], request->create_request.operation) != 0 ||
      strcmp(receipt_fields[2], item->create.selected) != 0 ||
      strcmp(receipt_fields[3], item->quarantine.control_digest) != 0 ||
      strcmp(receipt_fields[4], item->quarantine.quarantine_name) != 0 ||
      strcmp(receipt_fields[5], item->create.created_digest) != 0 ||
      !valid_digest(receipt_fields[6]) || strcmp(receipt_fields[7], item->create.content) != 0 ||
      !parse_uint(receipt_fields[8], MAX_ARTIFACT_BYTES, &length) ||
      length != item->create.length || strcmp(receipt_fields[9], "1") != 0 ||
      strcmp(receipt_fields[10], "1") != 0 || !valid_digest(receipt_fields[11])) return false;
  memcpy(item->quarantine.quarantine_digest, receipt_fields[6], DIGEST_BYTES + 1U);
  if (!rollback_build_receipt(request, item, receipt) || strcmp(receipt, bytes) != 0 ||
      strcmp(item->quarantine.receipt_digest, receipt_fields[11]) != 0 ||
      !capture_record_identity(root->recovery_fd, receipt_name, receipt,
        &item->quarantine.receipt_record)) return false;
  return true;
}

static bool rollback_commit_exact(
  RootBinding *root, RollbackRequest *request,
  const char (*controls)[MAX_RECORD_BYTES + 1U],
  const char (*receipts)[MAX_RECORD_BYTES + 1U]
) {
  if (!rollback_held_authority(root, request) || !rollback_private_authority_exact(root, request)) {
    return false;
  }
  for (size_t i = 0U; i < request->count; i += 1U) {
    RollbackItem *item = &request->items[i];
    if (!record_identity_exact(root->recovery_fd, item->quarantine.control_name,
          controls[i], &item->quarantine.control_record) ||
        !record_identity_exact(root->recovery_fd, item->quarantine.receipt_name,
          receipts[i], &item->quarantine.receipt_record) ||
        undo_quarantine_state(root, &item->quarantine, &(Identity){0}) != NAME_EXACT ||
        !rollback_missing_public_state(root, item, NAME_ABSENT)) return false;
  }
  return fsync(root->recovery_fd) == 0 && open_recovery(root, false);
}

static bool rollback_quarantine(RootBinding *root, RollbackRequest *request) {
  char (*controls)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*controls));
  char (*receipts)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*receipts));
  if (controls == NULL || receipts == NULL ||
      !rollback_private_authority_exact(root, request)) goto unknown;
  for (size_t i = 0U; i < request->count; i += 1U) {
    char control_name[128];
    char receipt_name[128];
    if (!rollback_record_names(request, &request->items[i], control_name, receipt_name)) {
      goto unknown;
    }
    memcpy(request->items[i].quarantine.control_name, control_name, strlen(control_name) + 1U);
    memcpy(request->items[i].quarantine.receipt_name, receipt_name, strlen(receipt_name) + 1U);
  }
  if (!rollback_namespace_clean(root->recovery_fd, request, NULL, NULL)) goto unknown;
  for (size_t i = 0U; i < request->count; i += 1U) {
    RollbackItem *item = &request->items[i];
    if (!random_private_quarantine(
          ".changes-history-native-rollback-create-quarantine.",
          item->quarantine.quarantine_name) ||
        !rollback_build_control(request, item, controls[i]) ||
        record_state(root->recovery_fd, item->quarantine.control_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, item->quarantine.receipt_name, "") != NAME_ABSENT ||
        !rollback_missing_public_state(root, item, NAME_EXACT)) goto unknown;
  }
  if (!rollback_namespace_clean(root->recovery_fd, request, controls, NULL)) {
    goto unknown;
  }
  size_t written = 0U;
  RecordAttempt failed_attempt;
  memset(&failed_attempt, 0, sizeof(failed_attempt));
  failed_attempt.fd = -1;
  for (; written < request->count; written += 1U) {
    RollbackItem *item = &request->items[written];
    Identity identity;
    if (!write_record(root->recovery_fd, item->quarantine.control_name,
          controls[written], &identity, &failed_attempt)) break;
    item->quarantine.control_record.identity = identity;
    sha256_prefixed((const unsigned char *)controls[written], strlen(controls[written]),
      item->quarantine.control_record.content);
  }
  if (written != request->count) {
    bool clean = !failed_attempt.created || failed_attempt.identity_bound;
#ifdef WRITCRAFT_TEST_PAUSE_CONTROL_FAILURE_BEFORE_CLEANUP
    if (failed_attempt.created &&
        !test_sync_point("control-failure-before-cleanup")) clean = false;
#endif
    if (failed_attempt.created && failed_attempt.identity_bound) {
      clean = unlink_attempted_record_owned(root->recovery_fd,
        request->items[written].quarantine.control_name, controls[written],
        &failed_attempt) && clean;
    }
    if (failed_attempt.fd >= 0) (void)close(failed_attempt.fd);
    for (size_t i = 0U; i < written; i += 1U) {
      clean = unlink_exact_record_owned(root->recovery_fd,
        request->items[i].quarantine.control_name, controls[i],
        &request->items[i].quarantine.control_record.identity, -1) && clean;
    }
    clean = rollback_uncommitted_exact(root, request) && clean;
    bool result = rollback_output(request, clean ? "UNCOMMITTED" : "UNKNOWN",
      clean ? "-" : "UNKNOWN");
    free(controls); free(receipts); return result;
  }
#ifdef WRITCRAFT_TEST_PAUSE_ROLLBACK_AFTER_CONTROLS
  if (!test_sync_point("rollback-after-controls")) goto unknown;
#endif
  for (size_t i = 0U; i < request->count; i += 1U) {
    RollbackItem *item = &request->items[i];
    if (!rollback_quarantine_one(root, request, i, controls, receipts) ||
        !rollback_build_receipt(request, item, receipts[i]) ||
        !write_record(root->recovery_fd, item->quarantine.receipt_name,
          receipts[i], &item->quarantine.receipt_record.identity, NULL)) goto unknown;
    sha256_prefixed((const unsigned char *)receipts[i], strlen(receipts[i]),
      item->quarantine.receipt_record.content);
  }
  if (!rollback_commit_exact(root, request, controls, receipts)) goto unknown;
#ifdef WRITCRAFT_TEST_PAUSE_ROLLBACK_AFTER_RECEIPT
  if (!test_sync_point("rollback-after-receipt")) goto unknown;
#endif
  if (!rollback_commit_exact(root, request, controls, receipts) ||
      !rollback_namespace_clean(root->recovery_fd, request, controls, receipts)) {
    goto unknown;
  }
#ifdef WRITCRAFT_TEST_DROP_ROLLBACK_COMMITTED_RESPONSE
  _exit(117);
#endif
  {
    bool result = rollback_output(request, "COMMITTED", "-");
    free(controls); free(receipts); return result;
  }
unknown:
  free(controls); free(receipts);
  return rollback_output(request, "UNKNOWN", "UNKNOWN");
}

static bool rollback_reconcile(RootBinding *root, RollbackRequest *request) {
  char (*controls)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*controls));
  char (*receipts)[MAX_RECORD_BYTES + 1U] = calloc(request->count, sizeof(*receipts));
  if (controls == NULL || receipts == NULL ||
      !rollback_private_authority_exact(root, request)) goto unknown;
  for (size_t i = 0U; i < request->count; i += 1U) {
    char control_name[128];
    char receipt_name[128];
    if (!rollback_record_names(request, &request->items[i], control_name, receipt_name)) {
      goto unknown;
    }
    memcpy(request->items[i].quarantine.control_name, control_name, strlen(control_name) + 1U);
    memcpy(request->items[i].quarantine.receipt_name, receipt_name, strlen(receipt_name) + 1U);
  }
  if (!rollback_namespace_clean(root->recovery_fd, request, NULL, NULL)) goto unknown;
  bool all_absent = true;
  bool all_committed = true;
  for (size_t i = 0U; i < request->count; i += 1U) {
    RollbackItem *item = &request->items[i];
    char control_name[128];
    char receipt_name[128];
    if (!rollback_record_names(request, item, control_name, receipt_name)) goto unknown;
    struct stat ignored;
    bool control_absent = fstatat(root->recovery_fd, control_name,
      &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
    bool receipt_absent = fstatat(root->recovery_fd, receipt_name,
      &ignored, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
    if (control_absent && receipt_absent) {
      all_committed = false;
      if (!rollback_missing_public_state(root, item, NAME_EXACT)) all_absent = false;
      continue;
    }
    all_absent = false;
    if (!rollback_load_records(root, request, item, controls[i], receipts[i]) ||
        undo_quarantine_state(root, &item->quarantine, &(Identity){0}) != NAME_EXACT ||
        !rollback_missing_public_state(root, item, NAME_ABSENT)) all_committed = false;
  }
  if (all_committed && rollback_commit_exact(root, request, controls, receipts) &&
      rollback_namespace_clean(root->recovery_fd, request, controls, receipts)) {
    bool result = rollback_output(request, "COMMITTED", "-");
    free(controls); free(receipts); return result;
  }
#ifdef WRITCRAFT_TEST_PAUSE_ROLLBACK_RECONCILE_BEFORE_UNCOMMITTED
  if (all_absent && !test_sync_point("rollback-reconcile-before-uncommitted")) goto unknown;
#endif
  if (all_absent && rollback_uncommitted_exact(root, request)) {
    bool result = rollback_output(request, "UNCOMMITTED", "-");
    free(controls); free(receipts); return result;
  }
unknown:
  free(controls); free(receipts);
  return rollback_output(request, "UNKNOWN", "UNKNOWN");
}

static bool rollback_nullable_identity_fields(char **fields, size_t start, RecordIdentity *out) {
  if (strcmp(fields[start], "-") == 0) {
    for (size_t i = 0U; i < 9U; i += 1U) if (strcmp(fields[start + i], "-") != 0) return false;
    memset(out, 0, sizeof(*out));
    return true;
  }
  return parse_identity_fields(fields, start, out);
}

static bool rollback_header(char *line, RollbackRequest *request) {
  char *fields[44];
  size_t field_count = 0U;
  uint64_t existing_count;
  uint64_t missing_count;
  uint64_t history_exists;
  bool qr = (line[0] == 'Q' || line[0] == 'R');
  bool d = line[0] == 'D';
  bool a = line[0] == 'A';
  size_t expected = qr ? 30U : (d ? 31U : (a ? 44U : 0U));
  if (expected == 0U || !split_fields(line, fields, 44U, &field_count) ||
      field_count != expected || strcmp(fields[1], "CREATE_ROLLBACK") != 0 ||
      !valid_operation(fields[2]) || !valid_digest(fields[3]) || !valid_digest(fields[4]) ||
      !parse_uint(fields[5], 96ULL * 1024ULL * 1024ULL, &request->marker_length) ||
      request->marker_length == 0U || !valid_digest(fields[6]) || !valid_digest(fields[7]) ||
      !valid_digest(fields[8]) || !parse_uint(fields[9], MAX_ARTIFACT_BYTES,
        &request->create_request.artifact_length) || request->create_request.artifact_length == 0U ||
      !valid_digest(fields[10]) || !valid_digest(fields[11]) || !valid_digest(fields[12]) ||
      !valid_digest(fields[13]) || !valid_digest(fields[14]) || !valid_digest(fields[15]) ||
      !decode_hex(fields[16], request->precreate_updated_at,
        sizeof(request->precreate_updated_at)) ||
      !strict_utf8((const unsigned char *)request->precreate_updated_at,
        strlen(request->precreate_updated_at)) ||
      !decode_hex(fields[17], request->original_updated_at, sizeof(request->original_updated_at)) ||
      !strict_utf8((const unsigned char *)request->original_updated_at,
        strlen(request->original_updated_at)) || !valid_digest(fields[18]) ||
      !valid_digest(fields[19]) || !valid_digest(fields[20]) || !valid_digest(fields[21]) ||
      !parse_uint(fields[22], 192ULL * 1024ULL * 1024ULL, &request->base_history_length) ||
      !parse_uint(fields[23], 1U, &history_exists) ||
      (history_exists == 1U ? (!valid_digest(fields[24]) || !valid_digest(fields[25])) :
        (strcmp(fields[24], "-") != 0 || strcmp(fields[25], "-") != 0)) ||
      !valid_digest(fields[26]) || !parse_uint(fields[27], MAX_ITEMS, &existing_count) ||
      !parse_uint(fields[28], MAX_ITEMS, &missing_count) || existing_count == 0U ||
      missing_count == 0U || existing_count + missing_count > MAX_ITEMS ||
      !valid_digest(fields[29])) return false;
  request->command = line[0];
  memcpy(request->create_request.operation, fields[2], strlen(fields[2]) + 1U);
  memcpy(request->request_digest, fields[3], DIGEST_BYTES + 1U);
  memcpy(request->marker_digest, fields[4], DIGEST_BYTES + 1U);
  memcpy(request->marker_identity, fields[6], DIGEST_BYTES + 1U);
  memcpy(request->create_request.artifact, fields[7], DIGEST_BYTES + 1U);
  memcpy(request->create_request.artifact_identity, fields[8], DIGEST_BYTES + 1U);
  memcpy(request->root_digest, fields[10], DIGEST_BYTES + 1U);
  memcpy(request->recovery_digest, fields[11], DIGEST_BYTES + 1U);
  memcpy(request->create_request.phase, fields[12], DIGEST_BYTES + 1U);
  memcpy(request->created_phase, fields[13], DIGEST_BYTES + 1U);
  memcpy(request->create_request.selection, fields[14], DIGEST_BYTES + 1U);
  memcpy(request->prepared_history, fields[15], DIGEST_BYTES + 1U);
  memcpy(request->existing_request, fields[18], DIGEST_BYTES + 1U);
  memcpy(request->existing_terminal, fields[19], DIGEST_BYTES + 1U);
  memcpy(request->existing_receipt_set, fields[20], DIGEST_BYTES + 1U);
  memcpy(request->base_history, fields[21], DIGEST_BYTES + 1U);
  request->base_history_exists = history_exists == 1U;
  if (request->base_history_exists) {
    memcpy(request->base_history_content, fields[24], DIGEST_BYTES + 1U);
    memcpy(request->base_history_identity, fields[25], DIGEST_BYTES + 1U);
  }
  memcpy(request->history_parent, fields[26], DIGEST_BYTES + 1U);
  memcpy(request->journal_digest, fields[29], DIGEST_BYTES + 1U);
  request->existing_count = (size_t)existing_count;
  request->count = (size_t)missing_count;
  request->create_request.count = request->count;
  if (d) {
    uint64_t token_count;
    if (!parse_uint(fields[30], MAX_ITEMS, &token_count) || token_count != missing_count) return false;
  } else if (a) {
    uint64_t token_count;
    if (!has_prefix(fields[30], ".changes-history-native-rollback-create-final.") ||
        strlen(fields[30]) >= sizeof(request->final_name) || !valid_digest(fields[31]) ||
        !valid_digest(fields[32]) || !decode_hex(fields[33], request->rolled_updated_at,
          sizeof(request->rolled_updated_at)) || !parse_identity_fields(fields, 34U,
          &request->final_record) || !parse_uint(fields[43], MAX_ITEMS, &token_count) ||
        token_count != missing_count) return false;
    memcpy(request->final_name, fields[30], strlen(fields[30]) + 1U);
    memcpy(request->final_digest, fields[31], DIGEST_BYTES + 1U);
    memcpy(request->rolled_phase, fields[32], DIGEST_BYTES + 1U);
  }
  return true;
}

static bool rollback_existing_line(char *line, RollbackRequest *request, size_t index) {
  char *fields[50];
  size_t count = 0U;
  RollbackExistingItem *item = &request->existing[index];
  uint64_t unused;
  if (!split_fields(line, fields, 50U, &count) || count != 50U || strcmp(fields[0], "E") != 0 ||
      !parse_uint(fields[1], MAX_ITEMS - 1U, &unused) ||
      !valid_selected(fields[2]) || !decode_hex(fields[3], item->path, sizeof(item->path)) ||
      !strict_utf8((const unsigned char *)item->path, strlen(item->path)) ||
      !valid_public_path(item->path) || strlen(fields[4]) != 64U || strlen(fields[5]) != 64U ||
      !parse_uint(fields[6], MAX_ARTIFACT_BYTES, &item->before_offset) ||
      !parse_uint(fields[7], MAX_ARTIFACT_BYTES, &item->before_length) ||
      !valid_digest(fields[8]) || !parse_uint(fields[9], MAX_ARTIFACT_BYTES, &item->after_offset) ||
      !parse_uint(fields[10], MAX_ARTIFACT_BYTES, &item->after_length) ||
      !valid_digest(fields[11]) || !valid_digest(fields[12]) || !valid_digest(fields[13]) ||
      !valid_digest(fields[14]) || !valid_digest(fields[15]) ||
      !has_prefix(fields[16], ".changes-history-native-existing-control.") ||
      !has_prefix(fields[17], ".changes-history-native-existing-rollback.") ||
      strlen(fields[16]) >= sizeof(item->control_name) ||
      strlen(fields[17]) >= sizeof(item->rollback_name) || !valid_digest(fields[18]) ||
      !((strcmp(fields[19], "-") == 0 && strcmp(fields[20], "-") == 0) ||
        (valid_digest(fields[19]) && valid_digest(fields[20]))) ||
      !valid_digest(fields[21]) || !valid_digest(fields[22]) ||
      !parse_identity_fields(fields, 23U, &item->control_record) ||
      !rollback_nullable_identity_fields(fields, 32U, &item->apply_record) ||
      !parse_identity_fields(fields, 41U, &item->rollback_record)) return false;
  item->parent_index = (size_t)unused;
  memcpy(item->selected, fields[2], strlen(fields[2]) + 1U);
  memcpy(item->before_revision, fields[4], 65U);
  memcpy(item->after_revision, fields[5], 65U);
  memcpy(item->before_content, fields[8], DIGEST_BYTES + 1U);
  memcpy(item->after_content, fields[11], DIGEST_BYTES + 1U);
  memcpy(item->ancestor, fields[12], DIGEST_BYTES + 1U);
  memcpy(item->before_leaf, fields[13], DIGEST_BYTES + 1U);
  memcpy(item->final_content, fields[14], DIGEST_BYTES + 1U);
  memcpy(item->final_leaf, fields[15], DIGEST_BYTES + 1U);
  memcpy(item->control_name, fields[16], strlen(fields[16]) + 1U);
  memcpy(item->rollback_name, fields[17], strlen(fields[17]) + 1U);
  memcpy(item->control_digest, fields[18], DIGEST_BYTES + 1U);
  item->has_apply = strcmp(fields[19], "-") != 0;
  if (item->has_apply) {
    memcpy(item->apply_digest, fields[19], DIGEST_BYTES + 1U);
    memcpy(item->after_leaf, fields[20], DIGEST_BYTES + 1U);
  }
  memcpy(item->rollback_digest, fields[21], DIGEST_BYTES + 1U);
  memcpy(item->restored_leaf, fields[22], DIGEST_BYTES + 1U);
  if (item->before_offset + item->before_length > request->create_request.artifact_length ||
      item->after_offset + item->after_length > request->create_request.artifact_length ||
      strcmp(item->final_content, item->before_content) != 0 ||
      strcmp(item->final_leaf, item->restored_leaf) != 0) return false;
  return true;
}

static bool rollback_missing_line(char *line, RollbackRequest *request, size_t index) {
  char *fields[31];
  size_t count = 0U;
  RollbackItem *item = &request->items[index];
  uint64_t parent_index;
  if (!split_fields(line, fields, 31U, &count) || count != 31U || strcmp(fields[0], "I") != 0 ||
      !parse_uint(fields[1], MAX_ITEMS - 1U, &parent_index) ||
      !valid_selected(fields[2]) || !decode_hex(fields[3], item->create.path,
        sizeof(item->create.path)) || !strict_utf8((const unsigned char *)item->create.path,
        strlen(item->create.path)) || !valid_public_path(item->create.path) ||
      !parse_uint(fields[4], request->create_request.artifact_length - 1U, &item->create.offset) ||
      !parse_uint(fields[5], request->create_request.artifact_length, &item->create.length) ||
      item->create.length == 0U || item->create.offset >
        request->create_request.artifact_length - item->create.length ||
      !valid_digest(fields[6]) || !valid_digest(fields[7]) || !valid_digest(fields[8]) ||
      !has_prefix(fields[9], ".changes-history-native-create-control.") ||
      !has_prefix(fields[10], ".changes-history-native-create-receipt.") ||
      strlen(fields[9]) >= sizeof(item->create_control_name) ||
      strlen(fields[10]) >= sizeof(item->create_receipt_name) ||
      !valid_digest(fields[11]) || !valid_digest(fields[12]) ||
      !parse_identity_fields(fields, 13U, &item->create_control_record) ||
      !parse_identity_fields(fields, 22U, &item->create_receipt_record)) return false;
  item->parent_index = (size_t)parent_index;
  memcpy(item->create.selected, fields[2], strlen(fields[2]) + 1U);
  memcpy(item->create.content, fields[6], DIGEST_BYTES + 1U);
  memcpy(item->create.ancestor, fields[7], DIGEST_BYTES + 1U);
  memcpy(item->create.created_digest, fields[8], DIGEST_BYTES + 1U);
  memcpy(item->create_control_name, fields[9], strlen(fields[9]) + 1U);
  memcpy(item->create_receipt_name, fields[10], strlen(fields[10]) + 1U);
  memcpy(item->create_control_digest, fields[11], DIGEST_BYTES + 1U);
  memcpy(item->create_receipt_digest, fields[12], DIGEST_BYTES + 1U);
  memcpy(item->quarantine.selected, fields[2], strlen(fields[2]) + 1U);
  memcpy(item->quarantine.path, item->create.path, strlen(item->create.path) + 1U);
  item->quarantine.length = item->create.length;
  memcpy(item->quarantine.content, item->create.content, DIGEST_BYTES + 1U);
  memcpy(item->quarantine.ancestor, item->create.ancestor, DIGEST_BYTES + 1U);
  memcpy(item->quarantine.created, item->create.created_digest, DIGEST_BYTES + 1U);
  return true;
}

static bool rollback_token_line(char *line, RollbackRequest *request, size_t index) {
  char *fields[29];
  size_t count = 0U;
  UndoItem *item = &request->items[index].quarantine;
  if (!split_fields(line, fields, 29U, &count) || count != 28U || strcmp(fields[0], "T") != 0 ||
      strcmp(fields[1], item->selected) != 0 ||
      !has_prefix(fields[2], ".changes-history-native-rollback-create-control.") ||
      !has_prefix(fields[3], ".changes-history-native-rollback-create-receipt.") ||
      !has_prefix(fields[4], ".changes-history-native-rollback-create-quarantine.") ||
      strlen(fields[2]) >= sizeof(item->control_name) ||
      strlen(fields[3]) >= sizeof(item->receipt_name) ||
      strlen(fields[4]) >= sizeof(item->quarantine_name) || !valid_digest(fields[5]) ||
      strcmp(fields[6], item->created) != 0 || !valid_digest(fields[7]) ||
      strcmp(fields[8], item->content) != 0 || !valid_digest(fields[9]) ||
      !parse_identity_fields(fields, 10U, &item->control_record) ||
      !parse_identity_fields(fields, 19U, &item->receipt_record)) return false;
  memcpy(item->control_name, fields[2], strlen(fields[2]) + 1U);
  memcpy(item->receipt_name, fields[3], strlen(fields[3]) + 1U);
  memcpy(item->quarantine_name, fields[4], strlen(fields[4]) + 1U);
  memcpy(item->control_digest, fields[5], DIGEST_BYTES + 1U);
  memcpy(item->quarantine_digest, fields[7], DIGEST_BYTES + 1U);
  memcpy(item->receipt_digest, fields[9], DIGEST_BYTES + 1U);
  return true;
}

static bool rollback_unknown_output(const RollbackRequest *request) {
  char line[512];
  int length;
  if (request->command == 'D') {
    length = snprintf(line, sizeof(line), "D\tRESULT\tUNKNOWN\t%s\t%s\t0\tUNKNOWN\n",
      request->create_request.operation, request->request_digest);
  } else if (request->command == 'A') {
    length = snprintf(line, sizeof(line), "A\tRESULT\tUNKNOWN\t%s\t%s\t%s\tUNKNOWN\n",
      request->create_request.operation, request->request_digest, request->final_digest);
  } else {
    length = snprintf(line, sizeof(line), "%c\tRESULT\tUNKNOWN\t%s\t%s\t0\tUNKNOWN\n",
      request->command, request->create_request.operation, request->request_digest);
  }
  return length > 0 && (size_t)length < sizeof(line) && write_line(line);
}

static bool rollback_fd_readonly(int fd) {
  int flags = fcntl(fd, F_GETFL);
  return flags >= 0 && (flags & O_ACCMODE) == O_RDONLY;
}

static bool rollback_path_is_fd(int directory, const char *name, int fd, bool is_directory) {
  struct stat held_stat;
  struct stat path_stat;
  Identity held;
  Identity at_path;
  if (fstat(fd, &held_stat) != 0 || fstatat(directory, name, &path_stat,
      AT_SYMLINK_NOFOLLOW) != 0 || !identity_from_stat(&held_stat, &held) ||
      !identity_from_stat(&path_stat, &at_path)) return false;
  return is_directory ? same_directory(&held, &at_path) : same_file(&held, &at_path);
}

static bool rollback_history_digest(int fd, uint64_t maximum, char out[72]) {
  struct stat before_stat;
  Identity before;
  if (fstat(fd, &before_stat) != 0 || !identity_from_stat(&before_stat, &before) ||
      !S_ISREG(before_stat.st_mode) || before.size > maximum) return false;
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  const unsigned char present = 1U;
  CC_SHA256_Update(&context, &present, 1U);
  unsigned char buffer[HASH_CHUNK_BYTES];
  uintmax_t offset = 0U;
  while (offset < before.size) {
    size_t wanted = before.size - offset > sizeof(buffer) ? sizeof(buffer) :
      (size_t)(before.size - offset);
    ssize_t got = pread(fd, buffer, wanted, (off_t)offset);
    if (got <= 0) return false;
    CC_SHA256_Update(&context, buffer, (CC_LONG)got);
    offset += (uintmax_t)got;
  }
  unsigned char raw[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(raw, &context);
  struct stat after_stat;
  Identity after;
  if (fstat(fd, &after_stat) != 0 || !identity_from_stat(&after_stat, &after) ||
      !same_file(&before, &after)) return false;
  memcpy(out, "sha256:", 7U);
  digest_hex(raw, out + 7U);
  return true;
}

static bool rollback_held_authority(RootBinding *root, RollbackRequest *request) {
  if (strcmp(request->root_digest, root->expected_root) != 0 ||
      strcmp(request->recovery_digest, root->expected_recovery) != 0 ||
      !artifact_valid(&request->create_request) || !open_recovery(root, false)) return false;
  char artifact_name[96];
  int artifact_length = snprintf(artifact_name, sizeof(artifact_name),
    "changes-history-%s.bin", request->create_request.operation);
  if (artifact_length <= 0 || (size_t)artifact_length >= sizeof(artifact_name) ||
      !record_path_matches_fd(root->recovery_fd, artifact_name, HELD_ARTIFACT_FD)) return false;
  Identity marker;
  char marker_content[72];
  char marker_identity[72];
  if (!rollback_fd_readonly(HELD_MARKER_FD) ||
      !hash_fd(HELD_MARKER_FD, &marker, marker_content, 96ULL * 1024ULL * 1024ULL) ||
      marker.uid != (uintmax_t)geteuid() || permission_mode(marker.mode) != 0600U ||
      marker.nlink != 1U || marker.size != request->marker_length ||
      strcmp(marker_content, request->journal_digest) != 0 ||
      !object_identity_digest(&marker, marker_content, marker_identity) ||
      strcmp(marker_identity, request->marker_identity) != 0 ||
      !record_path_matches_fd(root->recovery_fd, "changes-history-transaction.json",
        HELD_MARKER_FD)) return false;
  struct stat history_parent_stat;
  Identity history_parent;
  char history_parent_digest[72];
  if (!rollback_fd_readonly(HELD_HISTORY_PARENT_FD) ||
      fstat(HELD_HISTORY_PARENT_FD, &history_parent_stat) != 0 ||
      !identity_from_stat(&history_parent_stat, &history_parent) ||
      !S_ISDIR(history_parent_stat.st_mode) || history_parent.uid != (uintmax_t)geteuid() ||
      permission_mode(history_parent.mode) != 0700U ||
      !root_identity_digest(&history_parent, history_parent_digest) ||
      strcmp(history_parent_digest, request->history_parent) != 0 ||
      !rollback_path_is_fd(root->project_fd, ".writcraft", HELD_HISTORY_PARENT_FD, true)) return false;
  if (request->base_history_exists) {
    Identity history;
    char history_content[72];
    char history_identity[72];
    char history_digest[72];
    if (!rollback_fd_readonly(HELD_HISTORY_FD) ||
        !hash_fd(HELD_HISTORY_FD, &history, history_content, 192ULL * 1024ULL * 1024ULL) ||
        history.uid != (uintmax_t)geteuid() || permission_mode(history.mode) != 0600U ||
        history.nlink != 1U || history.size != request->base_history_length ||
        strcmp(history_content, request->base_history_content) != 0 ||
        !object_identity_digest(&history, history_content, history_identity) ||
        strcmp(history_identity, request->base_history_identity) != 0 ||
        !rollback_history_digest(HELD_HISTORY_FD, request->base_history_length, history_digest) ||
        strcmp(history_digest, request->base_history) != 0 ||
        !record_path_matches_fd(HELD_HISTORY_PARENT_FD, "changes.json", HELD_HISTORY_FD)) return false;
  } else {
    struct stat held_stat;
    Identity held;
    struct stat ignored;
    unsigned char absent = 0U;
    char absent_digest[72];
    sha256_prefixed(&absent, 1U, absent_digest);
    if (request->base_history_length != 0U ||
        strcmp(request->base_history, absent_digest) != 0 ||
        !rollback_fd_readonly(HELD_HISTORY_FD) || fstat(HELD_HISTORY_FD, &held_stat) != 0 ||
        !identity_from_stat(&held_stat, &held) || !same_directory(&held, &history_parent) ||
        fstatat(HELD_HISTORY_PARENT_FD, "changes.json", &ignored, AT_SYMLINK_NOFOLLOW) == 0 ||
        errno != ENOENT) return false;
  }
  return true;
}

static bool rollback_parse_and_run(RootBinding *root, char *line) {
  RollbackRequest *request = calloc(1U, sizeof(*request));
  if (request == NULL) return false;
  bool result = false;
  if (!rollback_header(line, request)) goto done;
  for (size_t i = 0U; i < request->existing_count; i += 1U) {
    if (!read_protocol_line(line) || !rollback_existing_line(line, request, i)) goto done;
  }
  for (size_t i = 0U; i < request->count; i += 1U) {
    if (!read_protocol_line(line) || !rollback_missing_line(line, request, i)) goto done;
  }
  if (request->command == 'D' || request->command == 'A') {
    for (size_t i = 0U; i < request->count; i += 1U) {
      if (!read_protocol_line(line) || !rollback_token_line(line, request, i)) goto done;
    }
  }
  bool valid = protocol_eof();
  if (!valid) DEBUG_STAGE("rollback-eof");
  if (valid) {
    valid = rollback_rebuilt_create_authority(request);
    if (!valid) DEBUG_STAGE("rollback-create-authority");
  }
  if (valid) {
    valid = rollback_existing_terminal_valid(request);
    if (!valid) DEBUG_STAGE("rollback-existing-terminal");
  }
  if (valid) {
    valid = rollback_request_digest_valid(request);
    if (!valid) DEBUG_STAGE("rollback-request-digest");
  }
  if (valid) {
    valid = rollback_held_authority(root, request);
    if (!valid) DEBUG_STAGE("rollback-held-authority");
  }
  if (valid && request->command == 'Q') result = rollback_quarantine(root, request);
  else if (valid && request->command == 'R') result = rollback_reconcile(root, request);
  else if (valid) result = rollback_unknown_output(request);
done:
  free(request);
  return result;
}

typedef struct {
  char selected[MAX_SELECTED_BYTES + 1U];
  char path[MAX_PATH_BYTES + 1U];
  char before_revision[65];
  char after_revision[65];
  uint64_t before_offset;
  uint64_t before_length;
  char before_content[DIGEST_BYTES + 1U];
  uint64_t after_offset;
  uint64_t after_length;
  char after_content[DIGEST_BYTES + 1U];
  char ancestor[DIGEST_BYTES + 1U];
  char before_leaf[DIGEST_BYTES + 1U];
  char after_leaf[DIGEST_BYTES + 1U];
  /* Fresh-R publication-time identities carried on the RECONCILE wire only.
   * The executor never recaptures them from the current control/apply record;
   * it reopens the stored records and requires their exact identity to match
   * these publication identities, otherwise the fresh R is UNKNOWN. */
  Identity control_stored;
  Identity apply_stored;
  bool stored_bound;
#ifdef WRITCRAFT_TEST_EXISTING_CANONICAL
  RecordIdentity control_record_identity;
  RecordIdentity apply_record_identity;
#endif
} ExistingExecuteItem;

typedef struct {
  char operation[64];
  char request_digest[DIGEST_BYTES + 1U];
  char marker_digest[DIGEST_BYTES + 1U];
  char artifact[DIGEST_BYTES + 1U];
  char artifact_identity[DIGEST_BYTES + 1U];
  uint64_t artifact_length;
  char created_phase[DIGEST_BYTES + 1U];
  char selection[DIGEST_BYTES + 1U];
  char base_history[DIGEST_BYTES + 1U];
  uint64_t base_history_length;
  bool base_history_exists;
  char base_history_content[DIGEST_BYTES + 1U];
  char history_parent[DIGEST_BYTES + 1U];
  /* WRCCHRJ2 journal single-authority binding carried on the E/R wire. */
  char binding_digest[DIGEST_BYTES + 1U];
  char slot;
  char journal_id[64];
  uint64_t generation;
  bool previous_is_null;
  char previous_digest[DIGEST_BYTES + 1U];
  char value_digest[DIGEST_BYTES + 1U];
  uint64_t frame_byte_length;
  char frame_sha256[DIGEST_BYTES + 1U];
  uint64_t payload_offset;
  uint64_t payload_byte_length;
  char payload_sha256[DIGEST_BYTES + 1U];
  uint64_t active_marker_offset;
  uint64_t active_marker_byte_length;
  char active_marker_digest[DIGEST_BYTES + 1U];
  char active_marker_canonical_sha256[DIGEST_BYTES + 1U];
  char root_identity[DIGEST_BYTES + 1U];
  char recovery_identity[DIGEST_BYTES + 1U];
  /* Fresh-R only: the E-time marker digest stored in the publication. The
   * control/apply records were built against it; the current journal binding
   * (active_marker_digest) may have advanced to EXISTING_COMMITTED. */
  char publication_marker_digest[DIGEST_BYTES + 1U];
  bool reconcile;
  size_t count;
  ExistingExecuteItem *items;
} ExistingExecuteRequest;

static bool valid_revision(const char *value) {
  if (value == NULL || strlen(value) != 64U) return false;
  for (size_t i = 0U; i < 64U; i += 1U) {
    if (!((value[i] >= '0' && value[i] <= '9') ||
          (value[i] >= 'a' && value[i] <= 'f'))) return false;
  }
  return true;
}

static bool existing_identity_fields(char **fields, size_t offset, Identity *out) {
  uint64_t dev = 0U;
  uint64_t ino = 0U;
  uint64_t uid = 0U;
  uint64_t mode = 0U;
  uint64_t nlink = 0U;
  uint64_t size = 0U;
  uint64_t mtime_ns = 0U;
  uint64_t ctime_ns = 0U;
  if (fields[offset] == NULL || strcmp(fields[offset], OBJECT_SCHEMA) != 0 ||
      !parse_uint(fields[offset + 1U], UINT64_MAX, &dev) ||
      !parse_uint(fields[offset + 2U], UINT64_MAX, &ino) ||
      !parse_uint(fields[offset + 3U], UINT64_MAX, &uid) ||
      !parse_uint(fields[offset + 4U], UINT64_MAX, &mode) ||
      !parse_uint(fields[offset + 5U], UINT64_MAX, &nlink) ||
      !parse_uint(fields[offset + 6U], UINT64_MAX, &size) ||
      !parse_uint(fields[offset + 7U], INTMAX_MAX, &mtime_ns) ||
      !parse_uint(fields[offset + 8U], INTMAX_MAX, &ctime_ns) ||
      !valid_digest(fields[offset + 9U]) || uid != (uint64_t)geteuid() ||
      mode != 0600U || nlink != 1U) return false;
  out->dev = (uintmax_t)dev;
  out->ino = (uintmax_t)ino;
  out->uid = (uintmax_t)uid;
  out->mode = (uintmax_t)(S_IFREG | mode);
  out->nlink = (uintmax_t)nlink;
  out->size = (uintmax_t)size;
  out->mtime_ns = (intmax_t)mtime_ns;
  out->ctime_ns = (intmax_t)ctime_ns;
  return true;
}

static bool existing_execute_item_line(
  char *line, ExistingExecuteRequest *request, size_t index
) {
  char *fields[36];
  size_t count = 0U;
  ExistingExecuteItem *item = &request->items[index];
  size_t expected = request->reconcile ? 34U : 13U;
  if (!split_fields(line, fields, 36U, &count) || count != expected ||
      strcmp(fields[0], "I") != 0 || !valid_selected(fields[1]) ||
      !decode_hex(fields[2], item->path, sizeof(item->path)) ||
      !strict_utf8((const unsigned char *)item->path, strlen(item->path)) ||
      !valid_public_path(item->path) || !valid_revision(fields[3]) ||
      !valid_revision(fields[4]) ||
      !parse_uint(fields[5], request->artifact_length, &item->before_offset) ||
      !parse_uint(fields[6], request->artifact_length, &item->before_length) ||
      item->before_length == 0U ||
      item->before_offset > request->artifact_length - item->before_length ||
      !valid_digest(fields[7]) ||
      !parse_uint(fields[8], request->artifact_length, &item->after_offset) ||
      !parse_uint(fields[9], request->artifact_length, &item->after_length) ||
      item->after_length == 0U ||
      item->after_offset > request->artifact_length - item->after_length ||
      !valid_digest(fields[10]) || !valid_digest(fields[11]) ||
      !valid_digest(fields[12])) return false;
  memcpy(item->selected, fields[1], strlen(fields[1]) + 1U);
  memcpy(item->before_revision, fields[3], sizeof(item->before_revision));
  memcpy(item->after_revision, fields[4], sizeof(item->after_revision));
  memcpy(item->before_content, fields[7], sizeof(item->before_content));
  memcpy(item->after_content, fields[10], sizeof(item->after_content));
  memcpy(item->ancestor, fields[11], sizeof(item->ancestor));
  memcpy(item->before_leaf, fields[12], sizeof(item->before_leaf));
  if (request->reconcile) {
    /* Fresh R carries the stored publication identities (control then apply)
     * plus the E-time publication marker digest; any foreign schema, malformed
     * stat field or digest is rejected before any record is reopened. */
    if (!existing_identity_fields(fields, 13U, &item->control_stored) ||
        !existing_identity_fields(fields, 23U, &item->apply_stored) ||
        !valid_digest(fields[33])) return false;
    memcpy(request->publication_marker_digest, fields[33],
      sizeof(request->publication_marker_digest));
    item->stored_bound = true;
  }
  for (size_t i = 0U; i < index; i += 1U) {
    ExistingExecuteItem *other = &request->items[i];
    if (strcmp(other->selected, item->selected) == 0 ||
        strcmp(other->path, item->path) == 0 ||
        strcmp(other->before_leaf, item->before_leaf) == 0) return false;
  }
  return true;
}

static bool existing_execute_header(char *line, ExistingExecuteRequest *request) {
  char *fields[34];
  size_t count = 0U;
  uint64_t item_count = 0U;
  uint64_t generation = 0U;
  if (!split_fields(line, fields, 34U, &count) || count != 33U ||
      (strcmp(fields[0], "E") != 0 && strcmp(fields[0], "R") != 0) ||
      !valid_operation(fields[1]) ||
      !valid_digest(fields[2]) || !valid_digest(fields[3]) ||
      strcmp(fields[4], JOURNAL_BASENAME) != 0 || strcmp(fields[5], JOURNAL_MAGIC) != 0 ||
      (strcmp(fields[6], "A") != 0 && strcmp(fields[6], "B") != 0) ||
      !valid_journal_id(fields[7]) ||
      !parse_uint(fields[8], UINT64_MAX, &generation) ||
      (strcmp(fields[9], "-") != 0 && !valid_digest(fields[9])) ||
      !valid_digest(fields[10]) ||
      !parse_uint(fields[11], JOURNAL_SLOT_CAPACITY, &request->frame_byte_length) ||
      request->frame_byte_length == 0U || !valid_digest(fields[12]) ||
      !parse_uint(fields[13], JOURNAL_SLOT_CAPACITY, &request->payload_offset) ||
      request->payload_offset == 0U ||
      !parse_uint(fields[14], JOURNAL_MAX_VALUE_BYTES, &request->payload_byte_length) ||
      request->payload_byte_length == 0U || !valid_digest(fields[15]) ||
      !parse_uint(fields[16], JOURNAL_SLOT_CAPACITY, &request->active_marker_offset) ||
      !parse_uint(fields[17], JOURNAL_MAX_VALUE_BYTES, &request->active_marker_byte_length) ||
      request->active_marker_byte_length == 0U ||
      !valid_digest(fields[18]) || !valid_digest(fields[19]) ||
      !valid_digest(fields[20]) || !valid_digest(fields[21]) ||
      !valid_digest(fields[22]) || !valid_digest(fields[23]) ||
      !parse_uint(fields[24], MAX_ARTIFACT_BYTES, &request->artifact_length) ||
      request->artifact_length == 0U || !valid_digest(fields[25]) ||
      !valid_digest(fields[26]) || !valid_digest(fields[27]) ||
      !parse_uint(fields[28], 192ULL * 1024ULL * 1024ULL, &request->base_history_length) ||
      (strcmp(fields[29], "0") != 0 && strcmp(fields[29], "1") != 0) ||
      (!strcmp(fields[29], "1") && !valid_digest(fields[30])) ||
      (!strcmp(fields[29], "0") && strcmp(fields[30], "-") != 0) ||
      !valid_digest(fields[31]) ||
      !parse_uint(fields[32], MAX_ITEMS, &item_count) || item_count == 0U ||
      (!strcmp(fields[29], "0") && request->base_history_length != 0U)) return false;
  request->items = calloc((size_t)item_count, sizeof(*request->items));
  if (request->items == NULL) return false;
  memcpy(request->operation, fields[1], sizeof(request->operation));
  memcpy(request->request_digest, fields[2], sizeof(request->request_digest));
  memcpy(request->binding_digest, fields[3], sizeof(request->binding_digest));
  request->slot = fields[6][0];
  memcpy(request->journal_id, fields[7], sizeof(request->journal_id));
  request->generation = generation;
  request->previous_is_null = strcmp(fields[9], "-") == 0;
  if (!request->previous_is_null) {
    memcpy(request->previous_digest, fields[9], sizeof(request->previous_digest));
  }
  memcpy(request->value_digest, fields[10], sizeof(request->value_digest));
  memcpy(request->frame_sha256, fields[12], sizeof(request->frame_sha256));
  memcpy(request->payload_sha256, fields[15], sizeof(request->payload_sha256));
  memcpy(request->active_marker_digest, fields[18], sizeof(request->active_marker_digest));
  memcpy(request->active_marker_canonical_sha256, fields[19],
    sizeof(request->active_marker_canonical_sha256));
  memcpy(request->root_identity, fields[20], sizeof(request->root_identity));
  memcpy(request->recovery_identity, fields[21], sizeof(request->recovery_identity));
  memcpy(request->artifact, fields[22], sizeof(request->artifact));
  memcpy(request->artifact_identity, fields[23], sizeof(request->artifact_identity));
  memcpy(request->created_phase, fields[25], sizeof(request->created_phase));
  memcpy(request->selection, fields[26], sizeof(request->selection));
  memcpy(request->base_history, fields[27], sizeof(request->base_history));
  request->base_history_exists = strcmp(fields[29], "1") == 0;
  memcpy(request->base_history_content, fields[30], sizeof(request->base_history_content));
  memcpy(request->history_parent, fields[31], sizeof(request->history_parent));
  request->reconcile = strcmp(fields[0], "R") == 0;
  request->count = (size_t)item_count;
  return true;
}

static bool existing_fd_readonly(int fd) {
  int flags = fcntl(fd, F_GETFL);
  return flags >= 0 && (flags & O_ACCMODE) == O_RDONLY;
}

static bool __attribute__((noinline)) existing_execute_leaf_before_exact(
  RootBinding *root, const ExistingExecuteItem *item
) {
  Ancestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  for (size_t index = 0U; index < MAX_ROOT_COMPONENTS; index += 1U) ancestors[index].fd = -1;
  size_t depth = 0U;
  int parent = -1;
  char leaf[MAX_PATH_BYTES + 1U];
  char ancestor_digest[72];
  if (!open_parent(root, item->path, ancestors, &depth, &parent, leaf, ancestor_digest) ||
      strcmp(ancestor_digest, item->ancestor) != 0 || !revalidate_parent(root, ancestors, depth)) {
    close_parent(ancestors, depth, parent);
    return false;
  }
  int fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity identity;
  char content[72];
  char escaped[MAX_PATH_BYTES * 2U + 1U];
  char canonical[MAX_RECORD_BYTES + 1U];
  char leaf_digest[72];
  bool valid = fd >= 0 && hash_fd(fd, &identity, content, item->before_length) &&
    identity.size == item->before_length && identity.nlink == 1U &&
    strcmp(content, item->before_content) == 0 &&
    record_path_matches_fd(parent, leaf, fd) && revalidate_parent(root, ancestors, depth) &&
    json_escape(item->path, escaped, sizeof(escaped));
  if (valid) {
    int length = snprintf(canonical, sizeof(canonical),
      "{\"ancestorIdentityDigest\":\"%s\",\"contentSha256\":\"%s\""
      ",\"ctimeNs\":\"%" PRIuMAX "\",\"dev\":\"%" PRIuMAX
      "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX
      ",\"mtimeNs\":\"%" PRIuMAX "\",\"nlink\":%" PRIuMAX
      ",\"path\":\"%s\",\"revision\":\"%s\",\"schema\":\""
      EXISTING_LEAF_SCHEMA "\",\"selectedId\":\"%s\",\"size\":\"%" PRIuMAX
      "\",\"uid\":%" PRIuMAX "}", item->ancestor, content,
      (uintmax_t)identity.ctime_ns, identity.dev, identity.ino,
      permission_mode(identity.mode), (uintmax_t)identity.mtime_ns, identity.nlink,
      escaped, item->before_revision, item->selected, identity.size, identity.uid);
    valid = length > 0 && (size_t)length < sizeof(canonical) &&
      digest_domain(EXISTING_LEAF_SCHEMA, canonical, leaf_digest) &&
      strcmp(leaf_digest, item->before_leaf) == 0;
  }
  if (fd >= 0) (void)close(fd);
  close_parent(ancestors, depth, parent);
  return valid;
}

static bool existing_execute_history_before_exact(
  RootBinding *root, const ExistingExecuteRequest *request
) {
  if (!existing_fd_readonly(HELD_HISTORY_PARENT_FD) ||
      !existing_fd_readonly(HELD_HISTORY_FD) ||
      !rollback_path_is_fd(root->project_fd, ".writcraft", HELD_HISTORY_PARENT_FD, true)) return false;
  struct stat parent_stat;
  struct stat history_stat;
  Identity parent_identity;
  Identity history_identity;
  if (fstat(HELD_HISTORY_PARENT_FD, &parent_stat) != 0 ||
      fstat(HELD_HISTORY_FD, &history_stat) != 0 ||
      !identity_from_stat(&parent_stat, &parent_identity) ||
      !identity_from_stat(&history_stat, &history_identity)) return false;
  if (!S_ISDIR(parent_stat.st_mode) || parent_identity.uid != (uintmax_t)geteuid() ||
      permission_mode(parent_identity.mode) != 0700U) return false;
  char parent_digest[72];
  if (!root_identity_digest(&parent_identity, parent_digest) ||
      strcmp(parent_digest, request->history_parent) != 0) return false;
  if (!request->base_history_exists) {
    char absent_digest[72];
    const unsigned char absent = 0x00U;
    sha256_prefixed(&absent, 1U, absent_digest);
    struct stat ignored;
    return request->base_history_length == 0U &&
      strcmp(request->base_history_content, "-") == 0 &&
      strcmp(request->base_history, absent_digest) == 0 &&
      same_directory(&parent_identity, &history_identity) &&
      S_ISDIR(history_stat.st_mode) &&
      fstatat(HELD_HISTORY_PARENT_FD, "changes.json", &ignored, AT_SYMLINK_NOFOLLOW) != 0 &&
      errno == ENOENT;
  }
  char content[72];
  char existence_digest[72];
  return S_ISREG(history_stat.st_mode) && history_stat.st_uid == geteuid() &&
    permission_mode(history_stat.st_mode) == 0600U && history_stat.st_nlink == 1U &&
    history_identity.size == request->base_history_length &&
    hash_fd_with_existence(
      HELD_HISTORY_FD, &history_identity, content, existence_digest, true,
      192ULL * 1024ULL * 1024ULL
    ) && strcmp(content, request->base_history_content) == 0 &&
    strcmp(existence_digest, request->base_history) == 0 &&
    record_path_matches_fd(HELD_HISTORY_PARENT_FD, "changes.json", HELD_HISTORY_FD);
}

static bool existing_journal_read_all(int fd, unsigned char *bytes, size_t length, off_t offset) {
  size_t used = 0U;
  while (used < length) {
    ssize_t got = pread(fd, bytes + used, length - used, offset + (off_t)used);
    if (got <= 0) return false;
    used += (size_t)got;
  }
  return true;
}

static void existing_journal_marker_digest(
  const unsigned char *bytes, size_t length, char out[72]
) {
  static const char domain[] = "writcraft-digest/v1";
  static const char prefix[] = "{\"marker\":";
  static const char suffix[] = ",\"schema\":\"" ACTIVE_MARKER_SCHEMA "\"}";
  unsigned char zero = 0U;
  unsigned char raw[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  CC_SHA256_Update(&context, domain, (CC_LONG)(sizeof(domain) - 1U));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, ACTIVE_MARKER_SCHEMA, (CC_LONG)strlen(ACTIVE_MARKER_SCHEMA));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, prefix, (CC_LONG)(sizeof(prefix) - 1U));
  CC_SHA256_Update(&context, bytes, (CC_LONG)length);
  CC_SHA256_Update(&context, suffix, (CC_LONG)(sizeof(suffix) - 1U));
  CC_SHA256_Final(raw, &context);
  memcpy(out, "sha256:", 7U);
  digest_hex(raw, out + 7U);
}

static bool existing_journal_identities_valid(
  RootBinding *root, const ExistingExecuteRequest *request
) {
  if (!open_recovery(root, false)) return false;
  struct stat root_stat;
  struct stat recovery_stat;
  Identity root_identity;
  Identity recovery_identity;
  char root_digest[72];
  char recovery_digest[72];
  if (fstat(root->project_fd, &root_stat) != 0 ||
      !identity_from_stat(&root_stat, &root_identity) ||
      !root_identity_digest(&root_identity, root_digest) ||
      strcmp(root_digest, request->root_identity) != 0) return false;
  if (fstat(root->recovery_fd, &recovery_stat) != 0 ||
      !identity_from_stat(&recovery_stat, &recovery_identity) ||
      !root_identity_digest(&recovery_identity, recovery_digest) ||
      strcmp(recovery_digest, request->recovery_identity) != 0) return false;
  return true;
}

/* WRCCHRJ2 single-authority validation: the marker lives inside the journal
 * frame, and the E/R request binds the journal's physical facts (frame bytes,
 * payload, active-marker slice, root/recovery identity digests). */
static bool existing_journal_marker_valid(RootBinding *root, const ExistingExecuteRequest *request) {
  struct stat stat_value;
  if (!existing_fd_readonly(HELD_MARKER_FD) ||
      fstat(HELD_MARKER_FD, &stat_value) == -1 || !S_ISREG(stat_value.st_mode) ||
      stat_value.st_uid != (uintmax_t)geteuid() ||
      permission_mode((uintmax_t)stat_value.st_mode) != 0600U || stat_value.st_nlink != 1U ||
      !record_path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, HELD_MARKER_FD)) return false;
  off_t slot_offset = request->slot == 'B' ? (off_t)JOURNAL_SLOT_CAPACITY : 0;
  unsigned char *frame = malloc((size_t)request->frame_byte_length);
  bool valid = frame != NULL && existing_journal_read_all(
    HELD_MARKER_FD, frame, (size_t)request->frame_byte_length, slot_offset
  );
  char observed[72];
  if (valid) {
    sha256_prefixed(frame, (size_t)request->frame_byte_length, observed);
    valid = strcmp(observed, request->frame_sha256) == 0;
  }
  size_t newline = 0U;
  while (valid && newline < request->frame_byte_length &&
      newline < JOURNAL_MAX_HEADER_BYTES && frame[newline] != '\n') newline += 1U;
  if (!valid || newline == 0U || newline >= request->frame_byte_length ||
      newline >= JOURNAL_MAX_HEADER_BYTES) valid = false;
  char header[JOURNAL_MAX_HEADER_BYTES + 1U];
  char *fields[8];
  size_t field_count = 0U;
  uint64_t payload_length = 0U;
  uint64_t parsed_generation = 0U;
  if (valid) {
    memcpy(header, frame, newline); header[newline] = '\0';
    valid = split_fields(header, fields, 8U, &field_count) && field_count == 8U &&
      strcmp(fields[0], JOURNAL_MAGIC) == 0 && fields[1][0] == request->slot &&
      fields[1][1] == '\0' && strcmp(fields[2], request->journal_id) == 0 &&
      parse_uint(fields[3], UINT64_MAX, &parsed_generation) &&
      parsed_generation == request->generation &&
      parse_uint(fields[4], JOURNAL_MAX_VALUE_BYTES, &payload_length) &&
      payload_length == request->payload_byte_length &&
      strcmp(fields[5], request->value_digest) == 0 &&
      (strcmp(fields[6], "-") == 0) == request->previous_is_null &&
      (request->previous_is_null || strcmp(fields[6], request->previous_digest) == 0) &&
      strcmp(fields[7], request->payload_sha256) == 0 &&
      request->frame_byte_length == newline + 1U + request->payload_byte_length;
  }
  const unsigned char *payload = frame + newline + 1U;
  if (valid) {
    sha256_prefixed(payload, (size_t)request->payload_byte_length, observed);
    valid = strcmp(observed, request->payload_sha256) == 0 &&
      payload[request->payload_byte_length - 1U] == '\n';
  }
  if (valid) {
    if (request->active_marker_offset < newline + 1U ||
        request->active_marker_offset + request->active_marker_byte_length >
          request->frame_byte_length) {
      valid = false;
    } else {
      const unsigned char *marker = frame + request->active_marker_offset;
      sha256_prefixed(marker, (size_t)request->active_marker_byte_length, observed);
      char marker_digest[72];
      existing_journal_marker_digest(
        marker, (size_t)request->active_marker_byte_length, marker_digest
      );
      valid = strcmp(observed, request->active_marker_canonical_sha256) == 0 &&
        strcmp(marker_digest, request->active_marker_digest) == 0;
    }
  }
  if (valid) valid = existing_journal_identities_valid(root, request);
  free(frame);
  return valid;
}

static bool existing_execute_nonpublic_authority_valid(
  RootBinding *root, const ExistingExecuteRequest *request
) {
  Request artifact_request;
  memset(&artifact_request, 0, sizeof(artifact_request));
  artifact_request.artifact_length = request->artifact_length;
  memcpy(artifact_request.artifact, request->artifact, sizeof(artifact_request.artifact));
  memcpy(artifact_request.artifact_identity, request->artifact_identity,
    sizeof(artifact_request.artifact_identity));
  char artifact_name[96];
  int artifact_name_length = snprintf(
    artifact_name, sizeof(artifact_name), "changes-history-%s.bin", request->operation
  );
  bool valid = artifact_name_length > 0 && (size_t)artifact_name_length < sizeof(artifact_name) &&
    strcmp(request->operation, "") != 0 && artifact_valid(&artifact_request);
  valid = valid && record_path_matches_fd(root->recovery_fd, artifact_name, HELD_ARTIFACT_FD);
  valid = valid && existing_journal_marker_valid(root, request) && existing_fd_readonly(HELD_HISTORY_PARENT_FD) &&
    existing_fd_readonly(HELD_HISTORY_FD) &&
    rollback_path_is_fd(root->project_fd, ".writcraft", HELD_HISTORY_PARENT_FD, true);
  valid = valid && existing_execute_history_before_exact(root, request);
  valid = valid && open_recovery(root, false);
  return valid;
}

static bool existing_execute_authority_valid(
  RootBinding *root, const ExistingExecuteRequest *request
) {
  if (!existing_execute_nonpublic_authority_valid(root, request)) return false;
  for (size_t index = 0U; index < request->count; index += 1U) {
    if (!existing_execute_leaf_before_exact(root, &request->items[index])) return false;
  }
  return true;
}

static bool __attribute__((unused)) existing_execute_leaf_restored_exact(
  RootBinding *root, const ExistingExecuteItem *item
) {
  Ancestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  for (size_t index = 0U; index < MAX_ROOT_COMPONENTS; index += 1U) ancestors[index].fd = -1;
  size_t depth = 0U;
  int parent = -1;
  char leaf[MAX_PATH_BYTES + 1U];
  char ancestor[72];
  if (!open_parent(root, item->path, ancestors, &depth, &parent, leaf, ancestor) ||
      strcmp(ancestor, item->ancestor) != 0 || !revalidate_parent(root, ancestors, depth)) {
    close_parent(ancestors, depth, parent);
    return false;
  }
  int fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity identity;
  char content[72];
  bool exact = fd >= 0 && hash_fd(fd, &identity, content, MAX_ARTIFACT_BYTES) &&
    identity.size == item->before_length && identity.nlink == 1U &&
    strcmp(content, item->before_content) == 0 &&
    record_path_matches_fd(parent, leaf, fd) && revalidate_parent(root, ancestors, depth);
  if (fd >= 0) (void)close(fd);
  close_parent(ancestors, depth, parent);
  return exact;
}

static bool existing_leaf_identity_digest_observed(
  const ExistingExecuteItem *item,
  const Identity *identity,
  const char *content,
  char out[72]
) {
  char escaped[MAX_PATH_BYTES * 2U + 1U];
  char canonical[MAX_RECORD_BYTES + 1U];
  if (item == NULL || identity == NULL || content == NULL ||
      !valid_digest(content) || !json_escape(item->path, escaped, sizeof(escaped))) return false;
  int length = snprintf(canonical, sizeof(canonical),
    "{\"ancestorIdentityDigest\":\"%s\",\"contentSha256\":\"%s\""
    ",\"ctimeNs\":\"%" PRIuMAX "\",\"dev\":\"%" PRIuMAX
    "\",\"ino\":\"%" PRIuMAX "\",\"mode\":%" PRIuMAX
    ",\"mtimeNs\":\"%" PRIuMAX "\",\"nlink\":%" PRIuMAX
    ",\"path\":\"%s\",\"revision\":\"%s\",\"schema\":\""
    EXISTING_LEAF_SCHEMA "\",\"selectedId\":\"%s\",\"size\":\"%" PRIuMAX
    "\",\"uid\":%" PRIuMAX "}", item->ancestor, content,
    (uintmax_t)identity->ctime_ns, identity->dev, identity->ino,
    permission_mode(identity->mode), (uintmax_t)identity->mtime_ns, identity->nlink,
    escaped, item->after_revision, item->selected, identity->size, identity->uid);
  return length > 0 && (size_t)length < sizeof(canonical) &&
    digest_domain(EXISTING_LEAF_SCHEMA, canonical, out);
}

static bool __attribute__((unused)) existing_execute_leaf_after_exact(
  RootBinding *root, const ExistingExecuteItem *item, const char expected_leaf[72]
) {
  Ancestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  for (size_t index = 0U; index < MAX_ROOT_COMPONENTS; index += 1U) ancestors[index].fd = -1;
  size_t depth = 0U;
  int parent = -1;
  char leaf[MAX_PATH_BYTES + 1U];
  char ancestor[72];
  if (!open_parent(root, item->path, ancestors, &depth, &parent, leaf, ancestor) ||
      strcmp(ancestor, item->ancestor) != 0 || !revalidate_parent(root, ancestors, depth)) {
    close_parent(ancestors, depth, parent);
    return false;
  }
  int fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity identity;
  char content[72];
  char observed_leaf[72];
  bool exact = fd >= 0 && hash_fd(fd, &identity, content, MAX_ARTIFACT_BYTES) &&
    identity.size == item->after_length && identity.nlink == 1U &&
    strcmp(content, item->after_content) == 0 &&
    record_path_matches_fd(parent, leaf, fd) &&
    revalidate_parent(root, ancestors, depth) &&
    existing_leaf_identity_digest_observed(item, &identity, content, observed_leaf) &&
    strcmp(observed_leaf, expected_leaf) == 0;
  if (fd >= 0) (void)close(fd);
  close_parent(ancestors, depth, parent);
  return exact;
}

static bool existing_execute_leaf_identity_after(
  RootBinding *root, const ExistingExecuteItem *item, char out[72]
) {
  Ancestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  for (size_t index = 0U; index < MAX_ROOT_COMPONENTS; index += 1U) ancestors[index].fd = -1;
  size_t depth = 0U;
  int parent = -1;
  char leaf[MAX_PATH_BYTES + 1U];
  char ancestor[72];
  if (!open_parent(root, item->path, ancestors, &depth, &parent, leaf, ancestor) ||
      strcmp(ancestor, item->ancestor) != 0 || !revalidate_parent(root, ancestors, depth)) {
    close_parent(ancestors, depth, parent);
    return false;
  }
  int fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity identity;
  char content[72];
  bool valid = fd >= 0 && hash_fd(fd, &identity, content, MAX_ARTIFACT_BYTES) &&
    identity.size == item->after_length && identity.nlink == 1U &&
    strcmp(content, item->after_content) == 0 && record_path_matches_fd(parent, leaf, fd) &&
    revalidate_parent(root, ancestors, depth) &&
    existing_leaf_identity_digest_observed(item, &identity, content, out);
  if (fd >= 0) (void)close(fd);
  close_parent(ancestors, depth, parent);
  return valid;
}

static bool existing_apply_record_build(
  const ExistingExecuteRequest *request,
  const ExistingExecuteItem *item,
  const char after_leaf[72],
  char apply_digest[72],
  char out[MAX_RECORD_BYTES + 1U]
);

static bool existing_held_path_exact(
  int directory,
  const char *name,
  int fd,
  const Identity *expected_identity,
  const char *expected_content,
  uint64_t expected_length,
  Identity *identity_out
) {
  Identity identity;
  char content[72];
  bool exact = fd >= 0 && hash_fd(fd, &identity, content, MAX_ARTIFACT_BYTES) &&
    identity.size == expected_length && strcmp(content, expected_content) == 0 &&
    (expected_identity == NULL || same_file(&identity, expected_identity)) &&
    record_path_matches_fd(directory, name, fd);
  if (exact && identity_out != NULL) *identity_out = identity;
  return exact;
}

typedef struct {
  char control_name[128];
  char control_digest[72];
  char apply_name[128];
  char apply_digest[72];
  char apply_record[MAX_RECORD_BYTES + 1U];
  char after_leaf[72];
  Identity control_identity;
  Identity apply_identity;
  RecordIdentity control_record;
  RecordIdentity apply_record_identity;
} ExistingCommitOutput;

static bool __attribute__((unused)) existing_swap_and_rollback(
  RootBinding *root,
  const ExistingExecuteRequest *request,
  const ExistingExecuteItem *item,
  const char *stage_name,
  const Identity *stage_identity,
  const char *before_name,
  const char *apply_name,
  const char *rollback_name,
  const char *control_name,
  const char *control_digest,
  const char *control_record,
  const Identity *control_identity,
  ExistingCommitOutput *commit
) {
  if (commit != NULL) memset(commit, 0, sizeof(*commit));
#if defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_SWAP) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_BEFORE_QUARANTINE) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_APPLY)
  (void)rollback_name;
  (void)control_name;
  (void)control_digest;
  (void)control_record;
  (void)control_identity;
#endif
  Ancestor ancestors[MAX_ROOT_COMPONENTS];
  memset(ancestors, 0, sizeof(ancestors));
  for (size_t index = 0U; index < MAX_ROOT_COMPONENTS; index += 1U) ancestors[index].fd = -1;
  size_t depth = 0U;
  int parent = -1;
  char leaf[MAX_PATH_BYTES + 1U];
  char ancestor[72];
  if (!open_parent(root, item->path, ancestors, &depth, &parent, leaf, ancestor) ||
      strcmp(ancestor, item->ancestor) != 0 || !revalidate_parent(root, ancestors, depth) ||
      !existing_execute_authority_valid(root, request)) {
    close_parent(ancestors, depth, parent);
    return false;
  }
  int before_fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  int staged_fd = openat(root->recovery_fd, stage_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity before_identity;
  Identity staged_identity;
  char before_content[72];
  char staged_content[72];
  bool exact = before_fd >= 0 && staged_fd >= 0 &&
    hash_fd(before_fd, &before_identity, before_content, MAX_ARTIFACT_BYTES) &&
    hash_fd(staged_fd, &staged_identity, staged_content, MAX_ARTIFACT_BYTES) &&
    before_identity.size == item->before_length && staged_identity.size == item->after_length &&
    strcmp(before_content, item->before_content) == 0 &&
    strcmp(staged_content, item->after_content) == 0 &&
    same_file(&staged_identity, stage_identity) &&
    record_path_matches_fd(parent, leaf, before_fd) &&
    record_path_matches_fd(root->recovery_fd, stage_name, staged_fd) &&
    revalidate_parent(root, ancestors, depth);
  if (!exact || renameatx_np(parent, leaf,
      root->recovery_fd, stage_name, RENAME_SWAP) != 0) {
    if (before_fd >= 0) (void)close(before_fd);
    if (staged_fd >= 0) (void)close(staged_fd);
    close_parent(ancestors, depth, parent);
    return false;
  }
  Identity swapped_after_identity;
  Identity swapped_before_identity;
  bool ok = fsync(parent) == 0 && fsync(root->recovery_fd) == 0 &&
    existing_held_path_exact(parent, leaf, staged_fd, NULL,
      item->after_content, item->after_length, &swapped_after_identity) &&
    existing_held_path_exact(root->recovery_fd, stage_name, before_fd, NULL,
      item->before_content, item->before_length, &swapped_before_identity) &&
    revalidate_parent(root, ancestors, depth);
  char observed_after_leaf[72];
  ok = ok && existing_leaf_identity_digest_observed(
    item, &swapped_after_identity, item->after_content, observed_after_leaf);
#ifdef WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_SWAP
  if (ok) ok = test_sync_point("existing-after-swap");
#endif
  ok = ok && existing_held_path_exact(parent, leaf, staged_fd,
      &swapped_after_identity, item->after_content, item->after_length, NULL) &&
    existing_held_path_exact(root->recovery_fd, stage_name, before_fd,
      &swapped_before_identity, item->before_content, item->before_length, NULL) &&
    revalidate_parent(root, ancestors, depth);
  if (ok) ok = renameatx_np(root->recovery_fd, stage_name,
    root->recovery_fd, before_name, RENAME_EXCL) == 0 &&
    fsync(root->recovery_fd) == 0 && fsync(parent) == 0;
  Identity quarantined_before_identity;
  Identity published_after_identity;
  ok = ok && existing_held_path_exact(parent, leaf, staged_fd, NULL,
      item->after_content, item->after_length, &published_after_identity) &&
    existing_held_path_exact(root->recovery_fd, before_name, before_fd, NULL,
      item->before_content, item->before_length, &quarantined_before_identity) &&
    revalidate_parent(root, ancestors, depth);
#ifdef WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_BEFORE_QUARANTINE
  if (ok) ok = test_sync_point("existing-after-before-quarantine");
#endif
  char after_leaf[72];
  char apply_digest[72];
  char apply_record[MAX_RECORD_BYTES + 1U];
  Identity apply_identity;
  if (ok) ok = existing_held_path_exact(parent, leaf, staged_fd,
      &published_after_identity, item->after_content, item->after_length, NULL) &&
    existing_held_path_exact(root->recovery_fd, before_name, before_fd,
      &quarantined_before_identity, item->before_content, item->before_length, NULL) &&
    revalidate_parent(root, ancestors, depth) &&
    existing_execute_nonpublic_authority_valid(root, request) &&
    existing_leaf_identity_digest_observed(
      item, &published_after_identity, item->after_content, after_leaf
    ) && existing_apply_record_build(
      request, item, after_leaf, apply_digest, apply_record
    ) && write_record(root->recovery_fd, apply_name, apply_record, &apply_identity, NULL);
#ifdef WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_APPLY
  if (ok) ok = test_sync_point("existing-after-apply");
#endif
#if defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_SWAP) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_BEFORE_QUARANTINE) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_APPLY)
  if (ok) {
    ok = record_identity_matches(root->recovery_fd, apply_name,
        apply_record, &apply_identity) &&
      existing_held_path_exact(parent, leaf, staged_fd,
        &published_after_identity, item->after_content, item->after_length, NULL) &&
      existing_held_path_exact(root->recovery_fd, before_name, before_fd,
        &quarantined_before_identity, item->before_content, item->before_length, NULL) &&
      revalidate_parent(root, ancestors, depth) &&
      renameatx_np(parent, leaf,
      root->recovery_fd, before_name, RENAME_SWAP) == 0 &&
      fsync(parent) == 0 && fsync(root->recovery_fd) == 0 &&
      record_path_matches_fd(parent, leaf, before_fd) &&
      record_path_matches_fd(root->recovery_fd, before_name, staged_fd) &&
      revalidate_parent(root, ancestors, depth) &&
      existing_stage_remove_exact(root->recovery_fd, before_name,
        &staged_identity, item->after_content, item->after_length) &&
      existing_execute_nonpublic_authority_valid(root, request) &&
      existing_execute_leaf_restored_exact(root, item) &&
      unlink_exact_record_owned(root->recovery_fd, apply_name,
        apply_record, &apply_identity, -1);
  }
#endif
#if !defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_SWAP) && \
    !defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_BEFORE_QUARANTINE) && \
    !defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_APPLY)
  if (ok) {
    ok = record_identity_matches(root->recovery_fd, control_name, control_record,
        control_identity) &&
      record_identity_matches(root->recovery_fd, apply_name, apply_record,
        &apply_identity) &&
      existing_held_path_exact(parent, leaf, staged_fd, &published_after_identity,
        item->after_content, item->after_length, NULL) &&
      existing_held_path_exact(root->recovery_fd, before_name, before_fd,
        &quarantined_before_identity, item->before_content, item->before_length, NULL) &&
      existing_execute_nonpublic_authority_valid(root, request) &&
      existing_leaf_identity_digest_observed(item, &published_after_identity,
        item->after_content, after_leaf) &&
      existing_stage_remove_exact(root->recovery_fd, before_name,
        &quarantined_before_identity, item->before_content, item->before_length) &&
      record_state(root->recovery_fd, before_name, "") == NAME_ABSENT &&
      record_state(root->recovery_fd, stage_name, "") == NAME_ABSENT &&
      record_state(root->recovery_fd, rollback_name, "") == NAME_ABSENT;
    if (ok && commit != NULL) {
      memcpy(commit->control_name, control_name, strlen(control_name) + 1U);
      memcpy(commit->control_digest, control_digest, sizeof(commit->control_digest));
      memcpy(commit->apply_name, apply_name, strlen(apply_name) + 1U);
      memcpy(commit->apply_digest, apply_digest, sizeof(commit->apply_digest));
      memcpy(commit->apply_record, apply_record, sizeof(commit->apply_record));
      memcpy(commit->after_leaf, after_leaf, sizeof(commit->after_leaf));
      commit->control_identity = *control_identity;
      commit->apply_identity = apply_identity;
      commit->control_record.identity = *control_identity;
      sha256_prefixed((const unsigned char *)control_record, strlen(control_record),
        commit->control_record.content);
      commit->apply_record_identity.identity = apply_identity;
      sha256_prefixed((const unsigned char *)apply_record, strlen(apply_record),
        commit->apply_record_identity.content);
    }
  }
#endif
  if (before_fd >= 0) (void)close(before_fd);
  if (staged_fd >= 0) (void)close(staged_fd);
  close_parent(ancestors, depth, parent);
  return ok;
}

static bool existing_canonical_control_digest(
  const ExistingExecuteRequest *request,
  const ExistingExecuteItem *item,
  char out[72]
) {
  char escaped[MAX_PATH_BYTES * 2U + 1U];
  char canonical[MAX_RECORD_BYTES + 1U];
  size_t path_length = strlen(item->path);
  if (!json_escape(item->path, escaped, sizeof(escaped)) ||
      path_length * 2U >= (MAX_PATH_BYTES * 2U) + 1U) return false;
  int length = snprintf(canonical, sizeof(canonical),
    "{\"afterArtifactOffset\":%" PRIu64 ",\"afterByteLength\":%" PRIu64
    ",\"afterContentDigest\":\"%s\",\"afterRevision\":\"%s\""
    ",\"ancestorIdentityDigest\":\"%s\",\"artifactDigest\":\"%s\""
    ",\"artifactIdentityDigest\":\"%s\",\"baseHistoryDigest\":\"%s\""
    ",\"beforeArtifactOffset\":%" PRIu64 ",\"beforeByteLength\":%" PRIu64
    ",\"beforeContentDigest\":\"%s\",\"beforeLeafIdentityDigest\":\"%s\""
    ",\"beforeRevision\":\"%s\",\"createdReceiptPhaseDigest\":\"%s\""
    ",\"markerDigest\":\"%s\",\"operationId\":\"%s\",\"path\":\"%s\""
    ",\"schema\":\"" EXISTING_CONTROL_SCHEMA "\",\"selectedId\":\"%s\""
    ",\"selectionDigest\":\"%s\"}",
    item->after_offset, item->after_length, item->after_content, item->after_revision,
    item->ancestor, request->artifact, request->artifact_identity, request->base_history,
    item->before_offset, item->before_length, item->before_content, item->before_leaf,
    item->before_revision, request->created_phase,
    request->reconcile ? request->publication_marker_digest : request->active_marker_digest,
    request->operation, escaped, item->selected, request->selection);
  return length > 0 && (size_t)length < sizeof(canonical) &&
    digest_domain(EXISTING_CONTROL_SCHEMA, canonical, out);
}

static bool existing_record_names(
  const ExistingExecuteRequest *request,
  const ExistingExecuteItem *item,
  char control_name[128],
  char apply_name[128],
  char rollback_name[128],
  char before_name[128],
  char stage_name[128]
) {
  char key[1024];
  char key_digest[72];
  int length = snprintf(key, sizeof(key),
    "{\"operationId\":\"%s\",\"requestDigest\":\"%s\",\"schema\":\""
    EXISTING_RECORD_KEY_SCHEMA "\",\"selectedId\":\"%s\"}",
    request->operation, request->request_digest, item->selected);
  if (length <= 0 || (size_t)length >= sizeof(key) ||
      !digest_domain(EXISTING_RECORD_KEY_SCHEMA, key, key_digest)) return false;
  length = snprintf(control_name, 128U,
    ".changes-history-native-existing-control.%s", key_digest + 7U);
  if (length <= 0 || length >= 128) return false;
  length = snprintf(apply_name, 128U,
    ".changes-history-native-existing-apply.%s", key_digest + 7U);
  if (length <= 0 || length >= 128) return false;
  length = snprintf(rollback_name, 128U,
    ".changes-history-native-existing-rollback.%s", key_digest + 7U);
  if (length <= 0 || length >= 128) return false;
  length = snprintf(before_name, 128U,
    ".changes-history-native-existing-before.%s", key_digest + 7U);
  if (length <= 0 || length >= 128) return false;
  length = snprintf(stage_name, 128U,
    ".changes-history-native-existing-stage.%s", key_digest + 7U);
  return length > 0 && length < 128;
}

static bool existing_control_record_build(
  const ExistingExecuteRequest *request,
  const ExistingExecuteItem *item,
  char control_name[128],
  char control_digest[72],
  char out[MAX_RECORD_BYTES + 1U]
) {
  char escaped[MAX_PATH_BYTES * 2U + 1U];
  char path_hex[(MAX_PATH_BYTES * 2U) + 1U];
  char apply_name[128];
  char rollback_name[128];
  char before_name[128];
  char stage_name[128];
  static const char alphabet[] = "0123456789abcdef";
  size_t path_length = strlen(item->path);
  if (!json_escape(item->path, escaped, sizeof(escaped)) ||
      path_length * 2U >= sizeof(path_hex) ||
      !existing_canonical_control_digest(request, item, control_digest) ||
      !existing_record_names(
        request, item, control_name, apply_name, rollback_name, before_name, stage_name
      )) return false;
  for (size_t i = 0U; i < path_length; i += 1U) {
    unsigned char byte = (unsigned char)item->path[i];
    path_hex[i * 2U] = alphabet[byte >> 4U];
    path_hex[(i * 2U) + 1U] = alphabet[byte & 0x0fU];
  }
  path_hex[path_length * 2U] = '\0';
  int length = snprintf(out, MAX_RECORD_BYTES + 1U,
    EXISTING_CONTROL_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s"
    "\t%" PRIu64 "\t%" PRIu64 "\t%s\t%" PRIu64 "\t%" PRIu64 "\t%s\t%s\t%s\t%s\n",
    request->operation, item->selected, path_hex,
    request->reconcile ? request->publication_marker_digest : request->active_marker_digest,
    request->artifact, request->artifact_identity, request->created_phase,
    request->selection, request->base_history, item->before_revision, item->after_revision,
    item->before_offset, item->before_length, item->before_content, item->after_offset,
    item->after_length, item->after_content, item->ancestor, item->before_leaf, control_digest);
  return length > 0 && length <= (int)MAX_RECORD_BYTES;
}

static bool __attribute__((unused)) existing_apply_record_build(
  const ExistingExecuteRequest *request,
  const ExistingExecuteItem *item,
  const char after_leaf[72],
  char apply_digest[72],
  char out[MAX_RECORD_BYTES + 1U]
) {
  char control_digest[72];
  char canonical[MAX_RECORD_BYTES + 1U];
  if (!existing_canonical_control_digest(request, item, control_digest) ||
      !valid_digest(after_leaf)) return false;
  int length = snprintf(canonical, sizeof(canonical),
    "{\"afterContentDigest\":\"%s\",\"afterLeafIdentityDigest\":\"%s\""
    ",\"controlDigest\":\"%s\",\"fileFsyncComplete\":true"
    ",\"operationId\":\"%s\",\"parentFsyncComplete\":true"
    ",\"recoveryFsyncComplete\":true,\"schema\":\"" EXISTING_APPLY_SCHEMA
    "\",\"selectedId\":\"%s\"}",
    item->after_content, after_leaf, control_digest, request->operation, item->selected);
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(EXISTING_APPLY_SCHEMA, canonical, apply_digest)) return false;
  length = snprintf(out, MAX_RECORD_BYTES + 1U,
    EXISTING_APPLY_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t1\t1\t1\t%s\n",
    request->operation, item->selected, control_digest, item->after_content,
    after_leaf, apply_digest);
  return length > 0 && length <= (int)MAX_RECORD_BYTES;
}

#ifdef WRITCRAFT_TEST_EXISTING_CANONICAL

static bool existing_canonical_control_record(
  const ExistingExecuteRequest *request,
  const ExistingExecuteItem *item
) {
  char escaped[MAX_PATH_BYTES * 2U + 1U];
  char path_hex[(MAX_PATH_BYTES * 2U) + 1U];
  char control_digest[72];
  char key_digest[72];
  char control_name[128];
  char line[MAX_RECORD_BYTES + 16U];
  static const char alphabet[] = "0123456789abcdef";
  size_t path_length = strlen(item->path);
  if (!json_escape(item->path, escaped, sizeof(escaped)) ||
      path_length * 2U >= sizeof(path_hex) ||
      !existing_canonical_control_digest(request, item, control_digest)) return false;
  for (size_t i = 0U; i < path_length; i += 1U) {
    unsigned char byte = (unsigned char)item->path[i];
    path_hex[i * 2U] = alphabet[byte >> 4U];
    path_hex[(i * 2U) + 1U] = alphabet[byte & 0x0fU];
  }
  path_hex[path_length * 2U] = '\0';
  int key_length = snprintf(line, sizeof(line),
    "{\"operationId\":\"%s\",\"requestDigest\":\"%s\",\"schema\":\""
    EXISTING_RECORD_KEY_SCHEMA "\",\"selectedId\":\"%s\"}",
    request->operation, request->request_digest, item->selected);
  if (key_length <= 0 || (size_t)key_length >= sizeof(line) ||
      !digest_domain(EXISTING_RECORD_KEY_SCHEMA, line, key_digest)) return false;
  key_length = snprintf(control_name, sizeof(control_name),
    ".changes-history-native-existing-control.%s", key_digest + 7U);
  if (key_length <= 0 || (size_t)key_length >= sizeof(control_name)) return false;
  char name_line[192];
  int name_length = snprintf(name_line, sizeof(name_line), "K\tNAME\t%s\n", control_name);
  if (name_length <= 0 || (size_t)name_length >= sizeof(name_line) || !write_line(name_line)) {
    return false;
  }
  int length = snprintf(line, sizeof(line),
    "K\tCONTROL\t" EXISTING_CONTROL_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s"
    "\t%" PRIu64 "\t%" PRIu64 "\t%s\t%" PRIu64 "\t%" PRIu64 "\t%s\t%s\t%s\t%s\n",
    request->operation, item->selected, path_hex, request->active_marker_digest,
    request->artifact, request->artifact_identity, request->created_phase,
    request->selection, request->base_history, item->before_revision, item->after_revision,
    item->before_offset, item->before_length, item->before_content, item->after_offset,
    item->after_length, item->after_content, item->ancestor, item->before_leaf, control_digest);
  return length > 0 && (size_t)length < sizeof(line) && write_line(line);
}

static bool existing_canonical_apply_record(
  const ExistingExecuteRequest *request,
  const ExistingExecuteItem *item
) {
  char control_digest[72];
  char canonical[MAX_RECORD_BYTES + 1U];
  char apply_digest[72];
  char line[MAX_RECORD_BYTES + 16U];
  if (!existing_canonical_control_digest(request, item, control_digest)) return false;
  int length = snprintf(canonical, sizeof(canonical),
    "{\"afterContentDigest\":\"%s\",\"afterLeafIdentityDigest\":\"%s\""
    ",\"controlDigest\":\"%s\",\"fileFsyncComplete\":true"
    ",\"operationId\":\"%s\",\"parentFsyncComplete\":true"
    ",\"recoveryFsyncComplete\":true,\"schema\":\"" EXISTING_APPLY_SCHEMA
    "\",\"selectedId\":\"%s\"}",
    item->after_content, item->after_leaf, control_digest,
    request->operation, item->selected);
  if (length <= 0 || (size_t)length >= sizeof(canonical) ||
      !digest_domain(EXISTING_APPLY_SCHEMA, canonical, apply_digest)) return false;
  length = snprintf(line, sizeof(line),
    "K\tAPPLY\t" EXISTING_APPLY_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t1\t1\t1\t%s\n",
    request->operation, item->selected, control_digest, item->after_content,
    item->after_leaf, apply_digest);
  return length > 0 && (size_t)length < sizeof(line) && write_line(line);
}

static bool existing_canonical_after_trailer(
  char *line, ExistingExecuteRequest *request
) {
  char *fields[24];
  size_t count = 0U;
  for (size_t index = 0U; index < request->count; index += 1U) {
    if (!read_protocol_line(line) || !split_fields(line, fields, 4U, &count) ||
        count != 3U || strcmp(fields[0], "K") != 0 ||
        strcmp(fields[1], "AFTER") != 0 || !valid_digest(fields[2])) return false;
    memcpy(request->items[index].after_leaf, fields[2], sizeof(request->items[index].after_leaf));
    for (size_t previous = 0U; previous < index; previous += 1U) {
      if (strcmp(request->items[previous].after_leaf, request->items[index].after_leaf) == 0) {
        return false;
      }
    }
    if (!read_protocol_line(line) || !split_fields(line, fields, 24U, &count) ||
        count != 22U || strcmp(fields[0], "K") != 0 ||
        strcmp(fields[1], "IDENTITY") != 0 ||
        strcmp(fields[2], OBJECT_SCHEMA) || strcmp(fields[12], OBJECT_SCHEMA) ||
        !parse_identity_fields(fields, 3U, &request->items[index].control_record_identity) ||
        !parse_identity_fields(fields, 13U, &request->items[index].apply_record_identity)) {
      return false;
    }
  }
  return true;
}

static bool existing_canonical_identity_records(const ExistingExecuteItem *item) {
  char line[MAX_LINE_BYTES + 1U];
  size_t used = (size_t)snprintf(line, sizeof(line), "K\tIDENTITY\t%s", OBJECT_SCHEMA);
  if (used >= sizeof(line) ||
      !append_identity(line, sizeof(line), &used, &item->control_record_identity) ||
      used + strlen("\t" OBJECT_SCHEMA) >= sizeof(line)) return false;
  used += (size_t)snprintf(line + used, sizeof(line) - used, "\t%s", OBJECT_SCHEMA);
  if (!append_identity(line, sizeof(line), &used, &item->apply_record_identity) ||
      used + 2U > sizeof(line)) return false;
  line[used++] = '\n';
  line[used] = '\0';
  return write_line(line);
}

static bool existing_canonical_terminal_parity(
  ExistingExecuteRequest *request
) {
  typedef struct {
    char control_name[128];
    char apply_name[128];
    char control_digest[72];
    char apply_digest[72];
    char token_digest[72];
    char *token;
  } CanonicalTerminalItem;
  CanonicalTerminalItem *items = calloc(request->count, sizeof(*items));
  char *set = calloc(MAX_INPUT_BYTES + 1U, 1U);
  char *terminal = calloc(MAX_INPUT_BYTES + 1U, 1U);
  char *response = calloc(MAX_EXISTING_OUTPUT_BYTES + 1U, 1U);
  if (items == NULL || set == NULL || terminal == NULL || response == NULL) goto fail;
  char line[MAX_LINE_BYTES + 1U];
  for (size_t index = 0U; index < request->count; index += 1U) {
    ExistingExecuteItem *item = &request->items[index];
    char rollback_name[128];
    char before_name[128];
    char stage_name[128];
    char apply_record[MAX_RECORD_BYTES + 1U];
    size_t used = 0U;
    items[index].token = calloc(MAX_RECORD_BYTES + 1U, 1U);
    if (items[index].token == NULL ||
        !existing_record_names(request, item, items[index].control_name,
          items[index].apply_name, rollback_name, before_name, stage_name) ||
        !existing_canonical_control_digest(request, item, items[index].control_digest) ||
        !existing_apply_record_build(request, item, item->after_leaf,
          items[index].apply_digest, apply_record) ||
        !rollback_append(items[index].token, MAX_RECORD_BYTES + 1U, &used,
          "{\"afterLeafIdentityDigest\":\"%s\",\"applyReceiptDigest\":\"%s\""
          ",\"controlBasename\":\"%s\",\"controlDigest\":\"%s\",\"controlRecordIdentity\":",
          item->after_leaf, items[index].apply_digest, items[index].control_name,
          items[index].control_digest) ||
        !rollback_identity_json(items[index].token, MAX_RECORD_BYTES + 1U, &used,
          &item->control_record_identity) ||
        !rollback_append(items[index].token, MAX_RECORD_BYTES + 1U, &used,
          ",\"receiptBasename\":\"%s\",\"receiptRecordIdentity\":",
          items[index].apply_name) ||
        !rollback_identity_json(items[index].token, MAX_RECORD_BYTES + 1U, &used,
          &item->apply_record_identity) ||
        !rollback_append(items[index].token, MAX_RECORD_BYTES + 1U, &used,
          ",\"schema\":\"" EXISTING_APPLY_TOKEN_SCHEMA "\",\"selectedId\":\"%s\"}",
          item->selected) ||
        !digest_domain(EXISTING_APPLY_TOKEN_SCHEMA, items[index].token,
          items[index].token_digest)) goto fail;
    int length = snprintf(line, sizeof(line), "K\tTOKEN\t%s\t%s\n",
      items[index].token_digest, items[index].token);
    if (length <= 0 || (size_t)length >= sizeof(line) || !write_line(line)) goto fail;
  }
  size_t used = 0U;
  if (!rollback_append(set, MAX_INPUT_BYTES + 1U, &used, "{\"items\":[")) goto fail;
  for (size_t index = 0U; index < request->count; index += 1U) {
    ExistingExecuteItem *item = &request->items[index];
    if ((index > 0U && !rollback_append(set, MAX_INPUT_BYTES + 1U, &used, ",")) ||
        !rollback_append(set, MAX_INPUT_BYTES + 1U, &used,
          "{\"applyToken\":%s,\"finalContentDigest\":\"%s\","
          "\"finalLeafIdentityDigest\":\"%s\",\"rollbackToken\":null,"
          "\"selectedId\":\"%s\"}", items[index].token, item->after_content,
          item->after_leaf, item->selected)) goto fail;
  }
  if (!rollback_append(set, MAX_INPUT_BYTES + 1U, &used,
      "],\"operationId\":\"%s\",\"requestDigest\":\"%s\",\"schema\":\""
      EXISTING_TERMINAL_SCHEMA "\",\"state\":\"COMMITTED\"}",
      request->operation, request->request_digest)) goto fail;
  char receipt_set_digest[72];
  char terminal_digest[72];
  if (!digest_domain(EXISTING_TERMINAL_SCHEMA, set, receipt_set_digest)) goto fail;
  int length = snprintf(line, sizeof(line), "K\tRECEIPT_SET\t%s\t%s\n",
    receipt_set_digest, set);
  if (length <= 0 || (size_t)length >= sizeof(line) || !write_line(line)) goto fail;
  used = 0U;
  if (!rollback_append(terminal, MAX_INPUT_BYTES + 1U, &used,
      "{\"artifactDigest\":\"%s\",\"baseHistoryDigest\":\"%s\","
      "\"createdReceiptPhaseDigest\":\"%s\",\"items\":[",
      request->artifact, request->base_history, request->created_phase)) goto fail;
  for (size_t index = 0U; index < request->count; index += 1U) {
    ExistingExecuteItem *item = &request->items[index];
    if ((index > 0U && !rollback_append(terminal, MAX_INPUT_BYTES + 1U, &used, ",")) ||
        !rollback_append(terminal, MAX_INPUT_BYTES + 1U, &used,
          "{\"applyToken\":%s,\"finalContentDigest\":\"%s\","
          "\"finalLeafIdentityDigest\":\"%s\",\"rollbackToken\":null,"
          "\"selectedId\":\"%s\"}", items[index].token, item->after_content,
          item->after_leaf, item->selected)) goto fail;
  }
  if (!rollback_append(terminal, MAX_INPUT_BYTES + 1U, &used,
      "],\"markerDigest\":\"%s\",\"operationId\":\"%s\","
      "\"receiptSetDigest\":\"%s\",\"recoveryFsyncComplete\":true,"
      "\"schema\":\"" EXISTING_TERMINAL_SCHEMA "\",\"selectionDigest\":\"%s\","
      "\"state\":\"COMMITTED\"}", request->active_marker_digest, request->operation,
      receipt_set_digest, request->selection) ||
      !digest_domain(EXISTING_TERMINAL_SCHEMA, terminal, terminal_digest)) goto fail;
  length = snprintf(line, sizeof(line), "K\tTERMINAL\t%s\t%s\n", terminal_digest, terminal);
  if (length <= 0 || (size_t)length >= sizeof(line) || !write_line(line)) goto fail;
  size_t response_used = 0U;
  if (!rollback_append(response, MAX_EXISTING_OUTPUT_BYTES + 1U, &response_used,
      "P\tOK\nE\tRESULT\tCOMMITTED\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%zu\t-\n",
      request->operation, request->request_digest, request->active_marker_digest, request->artifact,
      request->created_phase, request->selection, request->base_history, receipt_set_digest,
      terminal_digest, request->count) ||
      !rollback_append(response, MAX_EXISTING_OUTPUT_BYTES + 1U, &response_used,
      "T\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s", request->items[0].selected,
      request->items[0].after_content, request->items[0].after_leaf, items[0].control_name,
      items[0].apply_name, items[0].control_digest, items[0].apply_digest,
      request->items[0].after_leaf, OBJECT_SCHEMA) ||
      !append_identity(response, MAX_EXISTING_OUTPUT_BYTES + 1U, &response_used,
      &request->items[0].control_record_identity) ||
      !rollback_append(response, MAX_EXISTING_OUTPUT_BYTES + 1U, &response_used, "\t%s",
      OBJECT_SCHEMA) ||
      !append_identity(response, MAX_EXISTING_OUTPUT_BYTES + 1U, &response_used,
      &request->items[0].apply_record_identity)) goto fail;
  for (size_t index = 1U; index < request->count; index += 1U) {
    ExistingExecuteItem *item = &request->items[index];
    if (!rollback_append(response, MAX_EXISTING_OUTPUT_BYTES + 1U, &response_used, "\nT\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s",
        item->selected, item->after_content, item->after_leaf, items[index].control_name,
        items[index].apply_name, items[index].control_digest, items[index].apply_digest,
        item->after_leaf, OBJECT_SCHEMA) ||
        !append_identity(response, MAX_EXISTING_OUTPUT_BYTES + 1U, &response_used,
        &item->control_record_identity) ||
        !rollback_append(response, MAX_EXISTING_OUTPUT_BYTES + 1U, &response_used, "\t%s",
        OBJECT_SCHEMA) ||
        !append_identity(response, MAX_EXISTING_OUTPUT_BYTES + 1U, &response_used,
        &item->apply_record_identity)) goto fail;
  }
  if (!rollback_append(response, MAX_EXISTING_OUTPUT_BYTES + 1U, &response_used, "\n")) goto fail;
  char response_digest[72];
  sha256_prefixed((const unsigned char *)response, response_used, response_digest);
  length = snprintf(line, sizeof(line), "K\tRESPONSE\t%s\n", response_digest);
  if (length <= 0 || (size_t)length >= sizeof(line) || !write_line(line)) goto fail;
  for (size_t index = 0U; index < request->count; index += 1U) free(items[index].token);
  free(items); free(set); free(terminal); free(response);
  return true;
fail:
  if (items != NULL) {
    for (size_t index = 0U; index < request->count; index += 1U) free(items[index].token);
  }
  free(items); free(set); free(terminal); free(response);
  return false;
}
#endif

static bool __attribute__((unused)) existing_output_committed(
  char command,
  const ExistingExecuteRequest *request,
  const ExistingCommitOutput *commit
) {
  char token[MAX_RECORD_BYTES + 1U];
  static char set[MAX_INPUT_BYTES + 1U];
  static char terminal[MAX_INPUT_BYTES + 1U];
  static char line[MAX_EXISTING_OUTPUT_BYTES + 1U];
  char token_digest[72];
  char set_digest[72];
  char terminal_digest[72];
  size_t used = 0U;
  if (request == NULL || commit == NULL || request->count != 1U ||
      !rollback_append(token, sizeof(token), &used,
        "{\"afterLeafIdentityDigest\":\"%s\",\"applyReceiptDigest\":\"%s\","
        "\"controlBasename\":\"%s\",\"controlDigest\":\"%s\","
        "\"controlRecordIdentity\":", commit->after_leaf, commit->apply_digest,
        commit->control_name, commit->control_digest) ||
      !rollback_identity_json(token, sizeof(token), &used, &commit->control_record) ||
      !rollback_append(token, sizeof(token), &used,
        ",\"receiptBasename\":\"%s\",\"receiptRecordIdentity\":",
        commit->apply_name) ||
      !rollback_identity_json(token, sizeof(token), &used, &commit->apply_record_identity) ||
      !rollback_append(token, sizeof(token), &used,
        ",\"schema\":\"" EXISTING_APPLY_TOKEN_SCHEMA "\",\"selectedId\":\"%s\"}",
        request->items[0].selected) ||
      !digest_domain(EXISTING_APPLY_TOKEN_SCHEMA, token, token_digest)) return false;
  used = 0U;
  if (!rollback_append(set, sizeof(set), &used,
      "{\"items\":[{\"applyToken\":%s,\"finalContentDigest\":\"%s\","
      "\"finalLeafIdentityDigest\":\"%s\",\"rollbackToken\":null,"
      "\"selectedId\":\"%s\"}],\"operationId\":\"%s\",\"requestDigest\":\"%s\","
      "\"schema\":\"" EXISTING_TERMINAL_SCHEMA "\",\"state\":\"COMMITTED\"}",
      token, request->items[0].after_content, commit->after_leaf,
      request->items[0].selected, request->operation, request->request_digest) ||
      !digest_domain(EXISTING_TERMINAL_SCHEMA, set, set_digest)) return false;
  used = 0U;
  if (!rollback_append(terminal, sizeof(terminal), &used,
      "{\"artifactDigest\":\"%s\",\"baseHistoryDigest\":\"%s\","
      "\"createdReceiptPhaseDigest\":\"%s\",\"items\":[{\"applyToken\":%s,"
      "\"finalContentDigest\":\"%s\",\"finalLeafIdentityDigest\":\"%s\","
      "\"rollbackToken\":null,\"selectedId\":\"%s\"}],\"markerDigest\":\"%s\","
      "\"operationId\":\"%s\",\"receiptSetDigest\":\"%s\","
      "\"recoveryFsyncComplete\":true,\"schema\":\"" EXISTING_TERMINAL_SCHEMA
      "\",\"selectionDigest\":\"%s\",\"state\":\"COMMITTED\"}",
      request->artifact, request->base_history, request->created_phase, token,
      request->items[0].after_content, commit->after_leaf, request->items[0].selected,
      request->reconcile ? request->publication_marker_digest : request->active_marker_digest,
      request->operation, set_digest, request->selection) ||
      !digest_domain(EXISTING_TERMINAL_SCHEMA, terminal, terminal_digest)) return false;
  int length = snprintf(line, sizeof(line),
    "%c\tRESULT\tCOMMITTED\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t1\t-\n",
    command,
    request->operation, request->request_digest,
    request->reconcile ? request->publication_marker_digest : request->active_marker_digest,
    request->artifact,
    request->created_phase, request->selection, request->base_history, set_digest,
    terminal_digest);
  if (length <= 0 || (size_t)length >= sizeof(line) || !write_line(line)) return false;
  length = snprintf(line, sizeof(line), "T\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s",
    request->items[0].selected, request->items[0].after_content, commit->after_leaf,
    commit->control_name, commit->apply_name, commit->control_digest,
    commit->apply_digest, commit->after_leaf, OBJECT_SCHEMA);
  if (length <= 0 || (size_t)length >= sizeof(line)) return false;
  used = (size_t)length;
  if (!append_identity(line, sizeof(line), &used, &commit->control_record) ||
      !rollback_append(line, sizeof(line), &used, "\t%s", OBJECT_SCHEMA) ||
      !append_identity(line, sizeof(line), &used, &commit->apply_record_identity) ||
      !rollback_append(line, sizeof(line), &used, "\n")) return false;
  return write_line(line);
}

static bool existing_output_unknown(char command, const ExistingExecuteRequest *request) {
  char response[256];
  int length = snprintf(response, sizeof(response),
    "%c\tRESULT\tUNKNOWN\t%s\t%s\t-\t-\t-\t-\t-\t-\t-\t0\t%s\n",
    command, request->operation, request->request_digest, "EXISTING_RESTORE_UNKNOWN");
  return length > 0 && (size_t)length < sizeof(response) && write_line(response);
}

static bool existing_reconcile_readonly(RootBinding *root, char *line) {
  ExistingExecuteRequest request;
  ExistingCommitOutput commit;
  memset(&request, 0, sizeof(request));
  memset(&commit, 0, sizeof(commit));
  if (!existing_execute_header(line, &request)) return false;
  for (size_t index = 0U; index < request.count; index += 1U) {
    if (!read_protocol_line(line) || !existing_execute_item_line(line, &request, index)) return false;
  }
  if (!protocol_eof()) return false;
  bool valid = request.count == 1U && existing_execute_nonpublic_authority_valid(root, &request);
  char control_name[128];
  char apply_name[128];
  char rollback_name[128];
  char before_name[128];
  char stage_name[128];
  char control_digest[72];
  char control_record[MAX_RECORD_BYTES + 1U];
  char after_leaf[72];
  char apply_digest[72];
  char apply_record[MAX_RECORD_BYTES + 1U];
  ExistingExecuteItem *item = &request.items[0];
  if (valid && (!item->stored_bound ||
      !existing_control_record_build(&request, item, control_name, control_digest,
      control_record))) {
    valid = false;
  }
  if (valid && !existing_record_names(&request, item, control_name, apply_name,
      rollback_name, before_name, stage_name)) {
    valid = false;
  }
  if (valid && (record_state(root->recovery_fd, rollback_name, "") != NAME_ABSENT ||
      record_state(root->recovery_fd, before_name, "") != NAME_ABSENT ||
      record_state(root->recovery_fd, stage_name, "") != NAME_ABSENT)) {
    valid = false;
  }
  if (valid && !existing_execute_leaf_identity_after(root, item, after_leaf)) {
    valid = false;
  }
  if (valid && !existing_apply_record_build(&request, item, after_leaf, apply_digest, apply_record)) {
    valid = false;
  }
  if (valid && !capture_record_identity(root->recovery_fd, control_name, control_record,
      &commit.control_record)) {
    valid = false;
  }
  if (valid && !capture_record_identity(root->recovery_fd, apply_name, apply_record,
      &commit.apply_record_identity)) {
    valid = false;
  }
  if (valid && !same_file(&commit.control_record.identity, &item->control_stored)) {
    valid = false;
  }
  if (valid && !same_file(&commit.apply_record_identity.identity, &item->apply_stored)) {
    valid = false;
  }
  if (valid) {
    commit.control_identity = commit.control_record.identity;
    commit.apply_identity = commit.apply_record_identity.identity;
    if (!record_identity_matches(root->recovery_fd, control_name, control_record,
          &commit.control_identity) ||
        !record_identity_matches(root->recovery_fd, apply_name, apply_record,
          &commit.apply_identity)) valid = false;
  }
  if (valid) {
    memcpy(commit.control_name, control_name, sizeof(commit.control_name));
    memcpy(commit.control_digest, control_digest, sizeof(commit.control_digest));
    memcpy(commit.apply_name, apply_name, sizeof(commit.apply_name));
    memcpy(commit.apply_digest, apply_digest, sizeof(commit.apply_digest));
    memcpy(commit.apply_record, apply_record, sizeof(commit.apply_record));
    memcpy(commit.after_leaf, after_leaf, sizeof(commit.after_leaf));
    if (!existing_output_committed('R', &request, &commit)) valid = false;
  }
  if (!valid) return existing_output_unknown('R', &request);
  return true;
}

static bool existing_reconcile_header_shape(const char *line) {
  char copy[MAX_LINE_BYTES + 1U];
  char *fields[34];
  size_t count = 0U;
  size_t length = strlen(line);
  if (length >= sizeof(copy)) return false;
  memcpy(copy, line, length + 1U);
  return split_fields(copy, fields, 34U, &count) && count == 33U &&
    strcmp(fields[0], "R") == 0;
}

#define EXISTING_FINAL_RECORD_SCHEMA \
  "writcraft.changes-history-native-existing-final-record/v1"
#define EXISTING_FINAL_KEY_SCHEMA \
  "writcraft.changes-history-native-existing-final-key/v1"

/* EXISTING terminal finalize (F): seals the CAS-installed terminal with an
 * owner-private final record. The wire carries the terminal authority digests
 * that Main verified against the journal publication; the native side binds
 * them into the immutable final record and captures its exact identity. */
static bool existing_finalize(RootBinding *root, char *line) {
  char *fields[8];
  size_t count = 0U;
  uint64_t item_count = 0U;
  if (!split_fields(line, fields, 8U, &count) || count != 8U ||
      strcmp(fields[0], "F") != 0 || strcmp(fields[1], "PUBLISH") != 0 ||
      !valid_operation(fields[2]) || !valid_digest(fields[3]) ||
      (strcmp(fields[4], "COMMITTED") != 0 &&
       strcmp(fields[4], "UNCOMMITTED") != 0) ||
      !valid_digest(fields[5]) || !valid_digest(fields[6]) ||
      !parse_uint(fields[7], MAX_ITEMS, &item_count) || item_count == 0U ||
      !open_recovery(root, false)) {
    return false;
  }
  char canonical[1024];
  int wrote = snprintf(canonical, sizeof(canonical),
    "{\"itemCount\":%" PRIu64 ",\"operationId\":\"%s\""
    ",\"receiptSetDigest\":\"%s\",\"recoveryFsyncComplete\":true"
    ",\"requestDigest\":\"%s\",\"schema\":\"" EXISTING_FINAL_RECORD_SCHEMA
    "\",\"terminalReceiptDigest\":\"%s\",\"terminalState\":\"%s\"}",
    item_count, fields[2], fields[6], fields[3], fields[5], fields[4]);
  char final_digest[72];
  if (wrote <= 0 || (size_t)wrote >= sizeof(canonical) ||
      !digest_domain(EXISTING_FINAL_RECORD_SCHEMA, canonical, final_digest)) {
    return false;
  }
  char key[768];
  wrote = snprintf(key, sizeof(key),
    "{\"operationId\":\"%s\",\"requestDigest\":\"%s\",\"schema\":\""
    EXISTING_FINAL_KEY_SCHEMA "\",\"terminalReceiptDigest\":\"%s\"}",
    fields[2], fields[3], fields[5]);
  char key_digest[72];
  if (wrote <= 0 || (size_t)wrote >= sizeof(key) ||
      !digest_domain(EXISTING_FINAL_KEY_SCHEMA, key, key_digest)) {
    return false;
  }
  char final_name[128];
  wrote = snprintf(final_name, sizeof(final_name),
    ".changes-history-native-existing-final.%s", key_digest + 7U);
  if (wrote <= 0 || (size_t)wrote >= sizeof(final_name)) return false;
  char record[MAX_RECORD_BYTES + 1U];
  wrote = snprintf(record, sizeof(record),
    EXISTING_FINAL_RECORD_SCHEMA "\t%s\t%s\t%s\t%s\t%s\t%" PRIu64 "\t1\t%s\n",
    fields[2], fields[3], fields[4], fields[5], fields[6], item_count,
    final_digest);
  if (wrote <= 0 || (size_t)wrote >= sizeof(record)) return false;
  int final_fd = -1;
  Identity final_identity;
  NameState state = open_record_exact(
    root->recovery_fd, final_name, record, &final_fd, &final_identity
  );
  if (final_fd >= 0) (void)close(final_fd);
  if (state == NAME_ABSENT) {
    RecordAttempt attempt;
    memset(&attempt, 0, sizeof(attempt));
    attempt.fd = -1;
    if (!write_record(root->recovery_fd, final_name, record, &final_identity,
        &attempt)) {
      if (attempt.fd >= 0) (void)close(attempt.fd);
      return false;
    }
    if (attempt.fd >= 0) (void)close(attempt.fd);
    state = open_record_exact(
      root->recovery_fd, final_name, record, &final_fd, &final_identity
    );
    if (final_fd >= 0) (void)close(final_fd);
  }
  if (state != NAME_EXACT || !open_recovery(root, false)) {
    return false;
  }
  char record_digest[72];
  sha256_prefixed((const unsigned char *)record, strlen(record), record_digest);
  char line_out[2048];
  wrote = snprintf(line_out, sizeof(line_out),
    "F\tRESULT\tCOMMITTED\t%s\t%s\t%s\t%s\t%s\t%s\t%" PRIuMAX "\t%" PRIuMAX
    "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX "\t%" PRIuMAX
    "\t%" PRIuMAX "\t%s\n",
    fields[2], fields[3], final_digest, final_name,
    fields[4], fields[5],
    (uintmax_t)final_identity.dev, (uintmax_t)final_identity.ino,
    (uintmax_t)final_identity.uid, permission_mode(final_identity.mode),
    (uintmax_t)final_identity.nlink, (uintmax_t)final_identity.size,
    (uintmax_t)final_identity.mtime_ns, (uintmax_t)final_identity.ctime_ns,
    record_digest);
  return wrote > 0 && (size_t)wrote < sizeof(line_out) && write_line(line_out);
}

/* EXISTING terminal ACK (A): verifies the final record is still the exact
 * owner-private file Main sealed, then acknowledges it so cleanup may proceed. */
static bool existing_ack(RootBinding *root, char *line) {
  char *fields[16];
  size_t count = 0U;
  uint64_t dev, ino, uid, mode, nlink, size, mtime, ctime;
  if (!split_fields(line, fields, 16U, &count) || count != 16U ||
      strcmp(fields[0], "F") != 0 || strcmp(fields[1], "ACK") != 0 ||
      !valid_operation(fields[2]) || !valid_digest(fields[3]) ||
      !valid_digest_basename(fields[4], ".changes-history-native-existing-final.") ||
      !valid_digest(fields[5]) || !valid_digest(fields[6]) ||
      !parse_uint(fields[7], UINT64_MAX, &dev) ||
      !parse_uint(fields[8], UINT64_MAX, &ino) ||
      !parse_uint(fields[9], UINT64_MAX, &uid) ||
      !parse_uint(fields[10], UINT64_MAX, &mode) ||
      !parse_uint(fields[11], UINT64_MAX, &nlink) ||
      !parse_uint(fields[12], UINT64_MAX, &size) ||
      !parse_uint(fields[13], INTMAX_MAX, &mtime) ||
      !parse_uint(fields[14], INTMAX_MAX, &ctime) ||
      !valid_digest(fields[15]) || uid != (uint64_t)geteuid() ||
      mode != 0600U || nlink != 1U || !open_recovery(root, false)) {
    return false;
  }
  Identity expected;
  expected.dev = (uintmax_t)dev;
  expected.ino = (uintmax_t)ino;
  expected.uid = (uintmax_t)uid;
  expected.mode = (uintmax_t)(S_IFREG | mode);
  expected.nlink = (uintmax_t)nlink;
  expected.size = (uintmax_t)size;
  expected.mtime_ns = (intmax_t)mtime;
  expected.ctime_ns = (intmax_t)ctime;
  int fd = openat(root->recovery_fd, fields[4],
    O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  Identity identity;
  char content[72];
  bool valid = fd >= 0 && hash_fd(fd, &identity, content,
    MAX_RECORD_BYTES) && same_file(&expected, &identity) &&
    strcmp(content, fields[15]) == 0 &&
    record_path_matches_fd(root->recovery_fd, fields[4], fd) &&
    open_recovery(root, false);
  if (fd >= 0) (void)close(fd);
  if (!valid) return false;
  char line_out[512];
  int wrote = snprintf(line_out, sizeof(line_out),
    "F\tRESULT\tACKED\t%s\t%s\t%s\n", fields[2], fields[3], fields[5]);
  return wrote > 0 && (size_t)wrote < sizeof(line_out) && write_line(line_out);
}

/*
 * A1b transport checkpoint: consume the formal EXISTING execute wire without
 * treating a process-level response as a committed mutation.  The complete
 * E/R/V/F authority implementation is intentionally still fail-closed; this
 * parser prevents an unsupported command from falling through to the CREATE
 * grammar and preserves the stable UNKNOWN result envelope for reconciliation.
 */
static bool existing_execute_unknown(RootBinding *root, char *line) {
  ExistingExecuteRequest request;
  memset(&request, 0, sizeof(request));
  bool result = false;
  if (!existing_execute_header(line, &request)) { goto done; }
  for (size_t index = 0U; index < request.count; index += 1U) {
    if (!read_protocol_line(line) || !existing_execute_item_line(line, &request, index)) goto done;
  }
#ifdef WRITCRAFT_TEST_EXISTING_CANONICAL
  if (!existing_canonical_after_trailer(line, &request)) goto done;
#endif
  if (!protocol_eof() || !existing_execute_authority_valid(root, &request)) goto done;
  {
    char control_name[128];
    char control_digest[72];
    char control_record[MAX_RECORD_BYTES + 1U];
    if (!existing_control_record_build(
      &request, &request.items[0], control_name, control_digest, control_record
    )) goto done;
  }
#ifdef WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_PREFLIGHT
  if (!test_sync_point("existing-after-preflight") ||
      !existing_execute_authority_valid(root, &request)) goto done;
#endif
#ifndef WRITCRAFT_TEST_EXISTING_CANONICAL
  if (request.count == 1U) {
    char control_name[128];
    char apply_name[128];
    char rollback_name[128];
    char before_name[128];
    char stage_name[128];
    char control_digest[72];
    char control_record[MAX_RECORD_BYTES + 1U];
    Identity control_identity;
    RecordAttempt failed_attempt;
    memset(&failed_attempt, 0, sizeof(failed_attempt));
    failed_attempt.fd = -1;
    if (!existing_control_record_build(
      &request, &request.items[0], control_name, control_digest, control_record
    ) || !existing_record_names(
      &request, &request.items[0], control_name, apply_name, rollback_name,
      before_name, stage_name
    ) ||
        record_state(root->recovery_fd, control_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, apply_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, rollback_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, before_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, stage_name, "") != NAME_ABSENT ||
        !existing_execute_authority_valid(root, &request)) goto done;
    if (!write_record(root->recovery_fd, control_name, control_record,
      &control_identity, &failed_attempt)) {
      bool cleaned = unlink_attempted_record_owned(
        root->recovery_fd, control_name, control_record, &failed_attempt);
      if (failed_attempt.fd >= 0) (void)close(failed_attempt.fd);
      if (!cleaned) goto done;
      goto done;
    }
#ifdef WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_CONTROL
    if (!test_sync_point("existing-after-control")) goto done;
#endif
    ExistingStageAttempt stage_attempt;
    Identity stage_identity;
    ExistingCommitOutput commit;
    memset(&commit, 0, sizeof(commit));
    memset(&stage_attempt, 0, sizeof(stage_attempt));
    stage_attempt.fd = -1;
    if (!record_identity_matches(root->recovery_fd, control_name,
          control_record, &control_identity) ||
        record_state(root->recovery_fd, apply_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, rollback_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, before_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, stage_name, "") != NAME_ABSENT ||
        !existing_execute_authority_valid(root, &request) ||
        !existing_stage_write(root->recovery_fd, stage_name,
          request.items[0].after_offset, request.items[0].after_length,
          request.items[0].after_content, &stage_attempt, &stage_identity)) goto done;
#ifdef WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_STAGE
    if (!test_sync_point("existing-after-stage")) goto done;
#endif
    if (!record_identity_matches(root->recovery_fd, control_name,
          control_record, &control_identity) ||
        !existing_swap_and_rollback(root, &request, &request.items[0],
          stage_name, &stage_identity, before_name, apply_name, rollback_name,
          control_name, control_digest, control_record, &control_identity, &commit)) goto done;
#if defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_SWAP) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_BEFORE_QUARANTINE) || \
    defined(WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_APPLY)
    if (!existing_execute_nonpublic_authority_valid(root, &request) ||
        !existing_execute_leaf_restored_exact(root, &request.items[0]) ||
        !unlink_exact_record_owned(root->recovery_fd, control_name,
          control_record, &control_identity, -1) ||
        record_state(root->recovery_fd, control_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, apply_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, rollback_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, before_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, stage_name, "") != NAME_ABSENT) goto done;
#else
#ifdef WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_COMMIT_CLEANUP
    if (!test_sync_point("existing-after-commit-cleanup") ||
        !existing_execute_leaf_after_exact(root, &request.items[0], commit.after_leaf)) goto done;
#endif
    if (!existing_execute_nonpublic_authority_valid(root, &request) ||
        !record_identity_matches(root->recovery_fd, control_name, control_record,
          &control_identity) ||
        !record_identity_matches(root->recovery_fd, apply_name, commit.apply_record,
          &commit.apply_identity) ||
        record_state(root->recovery_fd, rollback_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, before_name, "") != NAME_ABSENT ||
        record_state(root->recovery_fd, stage_name, "") != NAME_ABSENT ||
        !existing_output_committed('E', &request, &commit)) goto done;
    result = true;
    goto done;
#endif
  }
#endif
#ifdef WRITCRAFT_TEST_EXISTING_CANONICAL
  for (size_t index = 0U; index < request.count; index += 1U) {
    if (!existing_canonical_control_record(&request, &request.items[index]) ||
        !existing_canonical_apply_record(&request, &request.items[index]) ||
        !existing_canonical_identity_records(&request.items[index])) goto done;
  }
  if (!existing_canonical_terminal_parity(&request)) goto done;
#endif
  {
    char response[256];
    int length = snprintf(response, sizeof(response),
      "E\tRESULT\tUNKNOWN\t%s\t%s\tUNKNOWN\n",
      request.operation, request.request_digest);
    result = length > 0 && (size_t)length < sizeof(response) && write_line(response);
  }
done:
  free(request.items);
  return result;
}

static bool create_journal_header(char *line, CreateJournalRequest *request) {
  char *fields[41];
  size_t count = 0U;
  uint64_t item_count = 0U;
  uint64_t generation_value = 0U;
  if (!split_fields(line, fields, 41U, &count) || count != 41U ||
      strcmp(fields[0], "CJ") != 0 || strcmp(fields[1], "CREATE_MISSING") != 0 ||
      !valid_digest(fields[2]) || !valid_operation(fields[3]) ||
      !decode_hex(fields[4], request->project, sizeof(request->project)) ||
      !strict_utf8((const unsigned char *)request->project, strlen(request->project)) ||
      strcmp(fields[5], "snapshot_restore") != 0 || !valid_digest(fields[6]) ||
      !valid_digest(fields[7]) || !valid_digest(fields[8]) ||
      !(strcmp(fields[9], "A") == 0 || strcmp(fields[9], "B") == 0) ||
      !valid_journal_id(fields[10]) || strlen(fields[10]) >= sizeof(request->journal_id) ||
      strlen(fields[11]) >= sizeof(request->generation) ||
      !parse_uint(fields[11], UINT64_MAX, &generation_value) ||
      fields[9][0] != (generation_value % 2U == 0U ? 'A' : 'B') ||
      !valid_digest(fields[12]) ||
      !parse_uint(fields[13], JOURNAL_SLOT_CAPACITY, &request->frame_length) ||
      request->frame_length == 0U || !valid_digest(fields[14]) ||
      !parse_uint(fields[15], JOURNAL_MAX_VALUE_BYTES, &request->payload_length) ||
      request->payload_length == 0U || !valid_digest(fields[16]) ||
      !parse_uint(fields[17], JOURNAL_MAX_VALUE_BYTES, &request->marker_offset) ||
      !parse_uint(fields[18], JOURNAL_MAX_VALUE_BYTES, &request->marker_length) ||
      request->marker_length == 0U || !valid_digest(fields[19]) ||
      !valid_digest(fields[20]) || !valid_digest(fields[21]) ||
      !parse_uint(fields[22], MAX_ARTIFACT_BYTES, &request->create.artifact_length) ||
      request->create.artifact_length == 0U || !valid_digest(fields[23]) ||
      !valid_digest(fields[24]) || !parse_uint(fields[25], MAX_ITEMS, &item_count) ||
      item_count == 0U) return false;
  for (size_t i = 0U; i < 5U; i += 1U) {
    size_t field = 26U + (i * 3U);
    if (!parse_uint(fields[field], JOURNAL_MAX_VALUE_BYTES, &request->slices[i].offset) ||
        !parse_uint(fields[field + 1U], JOURNAL_MAX_VALUE_BYTES, &request->slices[i].length) ||
        request->slices[i].length == 0U || !valid_digest(fields[field + 2U]) ||
        request->slices[i].offset > request->payload_length - request->slices[i].length) return false;
    memcpy(request->slices[i].digest, fields[field + 2U], DIGEST_BYTES + 1U);
  }
  for (size_t i = 0U; i < 5U; i += 1U) {
    uint64_t left_end = request->slices[i].offset + request->slices[i].length;
    if (!(left_end <= request->marker_offset ||
          request->marker_offset + request->marker_length <= request->slices[i].offset)) {
      return false;
    }
    for (size_t j = i + 1U; j < 5U; j += 1U) {
      uint64_t right_end = request->slices[j].offset + request->slices[j].length;
      if (!(left_end <= request->slices[j].offset ||
            right_end <= request->slices[i].offset)) return false;
    }
  }
  request->slot = fields[9][0];
  memcpy(request->command_digest, fields[2], DIGEST_BYTES + 1U);
  memcpy(request->request_digest, fields[6], DIGEST_BYTES + 1U);
  memcpy(request->publication_digest, fields[7], DIGEST_BYTES + 1U);
  memcpy(request->binding_digest, fields[8], DIGEST_BYTES + 1U);
  memcpy(request->create.operation, fields[3], strlen(fields[3]) + 1U);
  memcpy(request->journal_id, fields[10], strlen(fields[10]) + 1U);
  memcpy(request->generation, fields[11], strlen(fields[11]) + 1U);
  memcpy(request->value_digest, fields[12], DIGEST_BYTES + 1U);
  memcpy(request->frame_digest, fields[14], DIGEST_BYTES + 1U);
  memcpy(request->payload_digest, fields[16], DIGEST_BYTES + 1U);
  memcpy(request->marker_digest, fields[19], DIGEST_BYTES + 1U);
  memcpy(request->create.artifact, fields[20], DIGEST_BYTES + 1U);
  memcpy(request->create.artifact_identity, fields[21], DIGEST_BYTES + 1U);
  memcpy(request->create.phase, fields[23], DIGEST_BYTES + 1U);
  memcpy(request->create.selection, fields[24], DIGEST_BYTES + 1U);
  request->create.count = (size_t)item_count;
  return request->marker_offset <= request->payload_length - request->marker_length;
}

static bool create_journal_read_all(int fd, unsigned char *bytes, size_t length, off_t offset) {
  size_t used = 0U;
  while (used < length) {
    ssize_t got = pread(fd, bytes + used, length - used, offset + (off_t)used);
    if (got <= 0) return false;
    used += (size_t)got;
  }
  return true;
}

static bool create_journal_slice_exact(
  const unsigned char *payload, const CreateJournalSlice *slice,
  const unsigned char *expected, size_t expected_length
) {
  char observed[72];
  if (slice->length != expected_length) return false;
  sha256_prefixed(payload + slice->offset, (size_t)slice->length, observed);
  return strcmp(observed, slice->digest) == 0 &&
    memcmp(payload + slice->offset, expected, expected_length) == 0;
}

static void create_journal_active_marker_digest(
  const unsigned char *bytes, size_t length, char out[72]
) {
  static const char domain[] = "writcraft-digest/v1";
  static const char prefix[] = "{\"marker\":";
  static const char suffix[] = ",\"schema\":\"" ACTIVE_MARKER_SCHEMA "\"}";
  unsigned char zero = 0U;
  unsigned char raw[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  CC_SHA256_Update(&context, domain, (CC_LONG)(sizeof(domain) - 1U));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, ACTIVE_MARKER_SCHEMA, (CC_LONG)strlen(ACTIVE_MARKER_SCHEMA));
  CC_SHA256_Update(&context, &zero, 1U);
  CC_SHA256_Update(&context, prefix, (CC_LONG)(sizeof(prefix) - 1U));
  CC_SHA256_Update(&context, bytes, (CC_LONG)length);
  CC_SHA256_Update(&context, suffix, (CC_LONG)(sizeof(suffix) - 1U));
  CC_SHA256_Final(raw, &context);
  memcpy(out, "sha256:", 7U);
  digest_hex(raw, out + 7U);
}

typedef struct {
  bool valid;
  char slot;
  char journal_id[64];
  uint64_t generation;
  char value_digest[DIGEST_BYTES + 1U];
  bool previous_is_null;
  char previous_digest[DIGEST_BYTES + 1U];
} CreateJournalOuter;

static bool create_journal_outer(
  int fd, off_t offset, char expected_slot, CreateJournalOuter *outer, bool hash_payload
) {
  unsigned char header_bytes[JOURNAL_MAX_HEADER_BYTES];
  ssize_t got = pread(fd, header_bytes, sizeof(header_bytes), offset);
  if (got <= 0) return false;
  size_t newline = 0U;
  while (newline < (size_t)got && newline < JOURNAL_MAX_HEADER_BYTES &&
      header_bytes[newline] != '\n') {
    if (header_bytes[newline] == 0U || header_bytes[newline] > 0x7fU) return false;
    newline += 1U;
  }
  if (newline == 0U || newline >= (size_t)got || newline >= JOURNAL_MAX_HEADER_BYTES) return false;
  char header[JOURNAL_MAX_HEADER_BYTES + 1U];
  memcpy(header, header_bytes, newline);
  header[newline] = '\0';
  char *fields[8];
  size_t count = 0U;
  uint64_t generation = 0U;
  uint64_t payload_length = 0U;
  if (!split_fields(header, fields, 8U, &count) || count != 8U ||
      strcmp(fields[0], JOURNAL_MAGIC) != 0 || fields[1][0] != expected_slot ||
      fields[1][1] != '\0' || !valid_journal_id(fields[2]) ||
      strlen(fields[2]) >= sizeof(outer->journal_id) ||
      !parse_uint(fields[3], UINT64_MAX, &generation) ||
      expected_slot != (generation % 2U == 0U ? 'A' : 'B') ||
      !parse_uint(fields[4], JOURNAL_MAX_VALUE_BYTES, &payload_length) ||
      payload_length == 0U || !valid_digest(fields[5]) ||
      !(strcmp(fields[6], "-") == 0 || valid_digest(fields[6])) ||
      !valid_digest(fields[7]) || payload_length > SIZE_MAX - newline - 1U) return false;
  if (!hash_payload) {
    outer->valid = true;
    outer->slot = expected_slot;
    outer->generation = generation;
    memcpy(outer->journal_id, fields[2], strlen(fields[2]) + 1U);
    memcpy(outer->value_digest, fields[5], DIGEST_BYTES + 1U);
    outer->previous_is_null = strcmp(fields[6], "-") == 0;
    if (!outer->previous_is_null) memcpy(outer->previous_digest, fields[6], DIGEST_BYTES + 1U);
    return true;
  }
  size_t frame_length = newline + 1U + (size_t)payload_length;
  unsigned char *frame = malloc(frame_length);
  if (frame == NULL || !create_journal_read_all(fd, frame, frame_length, offset)) {
    free(frame);
    return false;
  }
  const unsigned char *payload = frame + newline + 1U;
  char payload_digest[72];
  sha256_prefixed(payload, (size_t)payload_length, payload_digest);
  bool valid = payload[payload_length - 1U] == '\n' &&
    memchr(payload, 0, (size_t)payload_length) == NULL &&
    strict_utf8(payload, (size_t)payload_length) &&
    strcmp(payload_digest, fields[7]) == 0;
  if (valid) {
    outer->valid = true;
    outer->slot = expected_slot;
    outer->generation = generation;
    memcpy(outer->journal_id, fields[2], strlen(fields[2]) + 1U);
    memcpy(outer->value_digest, fields[5], DIGEST_BYTES + 1U);
    outer->previous_is_null = strcmp(fields[6], "-") == 0;
    if (!outer->previous_is_null) {
      memcpy(outer->previous_digest, fields[6], DIGEST_BYTES + 1U);
    }
  }
  free(frame);
  return valid;
}

static bool create_journal_selected_mode(
  int fd, const CreateJournalRequest *request, bool hash_payload
) {
  CreateJournalOuter slots[2];
  memset(slots, 0, sizeof(slots));
  bool a = create_journal_outer(fd, 0, 'A', &slots[0], hash_payload);
  bool b = create_journal_outer(
    fd, (off_t)JOURNAL_SLOT_CAPACITY, 'B', &slots[1], hash_payload
  );
  const CreateJournalOuter *selected = NULL;
  if (a && !b && slots[0].generation == 0U && slots[0].previous_is_null) {
    selected = &slots[0];
  } else if (a && b && strcmp(slots[0].journal_id, slots[1].journal_id) == 0) {
    const CreateJournalOuter *older = slots[0].generation < slots[1].generation
      ? &slots[0] : &slots[1];
    const CreateJournalOuter *newer = older == &slots[0] ? &slots[1] : &slots[0];
    if (older->generation != UINT64_MAX && newer->generation == older->generation + 1U &&
        !newer->previous_is_null &&
        strcmp(newer->previous_digest, older->value_digest) == 0) {
      selected = newer;
    }
  }
  uint64_t expected_generation = 0U;
  return selected != NULL && parse_uint(request->generation, UINT64_MAX, &expected_generation) &&
    selected->slot == request->slot && selected->generation == expected_generation &&
    strcmp(selected->journal_id, request->journal_id) == 0 &&
    strcmp(selected->value_digest, request->value_digest) == 0;
}

static bool create_journal_selected(int fd, const CreateJournalRequest *request) {
  return create_journal_selected_mode(fd, request, true);
}

static bool create_journal_selected_cheap(int fd, const CreateJournalRequest *request) {
  return create_journal_selected_mode(fd, request, false);
}

static bool create_journal_request_publication(
  const CreateJournalRequest *request, char *publication, size_t publication_capacity
) {
  char *canonical = calloc(MAX_INPUT_BYTES + 1U, 1U);
  if (canonical == NULL) return false;
  size_t used = 0U;
  bool valid = rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
    "{\"artifactByteLength\":%" PRIu64 ",\"artifactDigest\":\"%s\","
    "\"artifactIdentityDigest\":\"%s\",\"items\":[",
    request->create.artifact_length, request->create.artifact,
    request->create.artifact_identity);
  for (size_t i = 0U; valid && i < request->create.count; i += 1U) {
    const Item *item = &request->create.items[i];
    char escaped_path[(MAX_PATH_BYTES * 2U) + 1U];
    char escaped_selected[(MAX_SELECTED_BYTES * 2U) + 1U];
    valid = json_escape(item->path, escaped_path, sizeof(escaped_path)) &&
      json_escape(item->selected, escaped_selected, sizeof(escaped_selected)) &&
      rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
        "%s{\"ancestorIdentityDigest\":\"%s\",\"artifactOffset\":%" PRIu64
        ",\"byteLength\":%" PRIu64 ",\"contentDigest\":\"%s\","
        "\"path\":\"%s\",\"selectedId\":\"%s\"}", i == 0U ? "" : ",",
        item->ancestor, item->offset, item->length, item->content, escaped_path,
        escaped_selected);
  }
  valid = valid && rollback_append(canonical, MAX_INPUT_BYTES + 1U, &used,
    "],\"operationId\":\"%s\",\"precreatePhaseDigest\":\"%s\","
    "\"schema\":\"" CREATE_REQUEST_SCHEMA "\",\"selectionDigest\":\"%s\"}",
    request->create.operation, request->create.phase, request->create.selection);
  char request_digest[72];
  valid = valid && digest_domain(CREATE_REQUEST_SCHEMA, canonical, request_digest) &&
    strcmp(request_digest, request->request_digest) == 0;
  char attempt_canonical[1024];
  int attempt_length = valid ? snprintf(attempt_canonical, sizeof(attempt_canonical),
    "{\"operationId\":\"%s\",\"precreatePhaseDigest\":\"%s\","
    "\"requestDigest\":\"%s\",\"schema\":\"" CREATE_ATTEMPT_SCHEMA "\","
    "\"selectionDigest\":\"%s\"}", request->create.operation,
    request->create.phase, request_digest, request->create.selection) : -1;
  char attempt_digest[72];
  valid = valid && attempt_length > 0 &&
    (size_t)attempt_length < sizeof(attempt_canonical) &&
    digest_domain(CREATE_ATTEMPT_SCHEMA, attempt_canonical, attempt_digest);
  char without_digest[4096];
  int length = valid ? snprintf(without_digest, sizeof(without_digest),
    "{\"command\":\"CREATE_MISSING\",\"createAttemptDigest\":null,"
    "\"createCapture\":null,\"createCleanupFinalBasename\":null,"
    "\"createCleanupFinalRecordIdentity\":null,"
    "\"createFinalization\":null,"
    "\"kind\":\"snapshot_restore\",\"mutation\":{"
    "\"directoryFsyncComplete\":false,\"privateBasename\":null,"
    "\"schema\":\"" MUTATION_SCHEMA "\",\"sourceIdentityDigest\":null,"
    "\"state\":\"UNARMED\"},\"operationId\":\"%s\","
    "\"phaseDigest\":\"%s\",\"previousPublicationDigest\":null,"
    "\"records\":[],\"requestDigest\":\"%s\",\"schema\":\""
    PUBLICATION_SCHEMA "\",\"state\":\"PREPARED\"}",
    request->create.operation, request->create.phase, request_digest) : -1;
  char initial_publication_digest[72];
  valid = valid && length > 0 && (size_t)length < sizeof(without_digest) &&
    digest_domain(PUBLICATION_SCHEMA, without_digest, initial_publication_digest);
  length = valid ? snprintf(without_digest, sizeof(without_digest),
    "{\"command\":\"CREATE_MISSING\",\"createAttemptDigest\":\"%s\","
    "\"createCapture\":null,\"createCleanupFinalBasename\":null,"
    "\"createCleanupFinalRecordIdentity\":null,"
    "\"createFinalization\":null,\"kind\":\"snapshot_restore\",\"mutation\":{"
    "\"directoryFsyncComplete\":false,\"privateBasename\":null,"
    "\"schema\":\"" MUTATION_SCHEMA "\",\"sourceIdentityDigest\":null,"
    "\"state\":\"UNARMED\"},\"operationId\":\"%s\","
    "\"phaseDigest\":\"%s\",\"previousPublicationDigest\":\"%s\","
    "\"records\":[],\"requestDigest\":\"%s\",\"schema\":\""
    PUBLICATION_SCHEMA "\",\"state\":\"PREPARED\"}",
    attempt_digest, request->create.operation, request->create.phase,
    initial_publication_digest, request_digest) : -1;
  char publication_digest[72];
  valid = valid && length > 0 && (size_t)length < sizeof(without_digest) &&
    digest_domain(PUBLICATION_SCHEMA, without_digest, publication_digest) &&
    strcmp(publication_digest, request->publication_digest) == 0;
  length = valid ? snprintf(publication, publication_capacity,
    "{\"command\":\"CREATE_MISSING\",\"createAttemptDigest\":\"%s\","
    "\"createCapture\":null,\"createCleanupFinalBasename\":null,"
    "\"createCleanupFinalRecordIdentity\":null,"
    "\"createFinalization\":null,"
    "\"kind\":\"snapshot_restore\",\"mutation\":{"
    "\"directoryFsyncComplete\":false,\"privateBasename\":null,"
    "\"schema\":\"" MUTATION_SCHEMA "\",\"sourceIdentityDigest\":null,"
    "\"state\":\"UNARMED\"},\"operationId\":\"%s\","
    "\"phaseDigest\":\"%s\",\"previousPublicationDigest\":\"%s\","
    "\"publicationDigest\":\"%s\",\"records\":[],\"requestDigest\":\"%s\","
    "\"schema\":\"" PUBLICATION_SCHEMA "\",\"state\":\"PREPARED\"}",
    attempt_digest, request->create.operation, request->create.phase,
    initial_publication_digest, publication_digest, request_digest) : -1;
  free(canonical);
  return valid && length > 0 && (size_t)length < publication_capacity;
}

static bool create_journal_command_authority(const CreateJournalRequest *request) {
  char escaped_project[(MAX_PATH_BYTES * 2U) + 1U];
  if (!json_escape(request->project, escaped_project, sizeof(escaped_project))) return false;
  char canonical[32768];
  int length = snprintf(canonical, sizeof(canonical),
    "{\"activeMarkerByteLength\":%" PRIu64 ",\"activeMarkerDigest\":\"%s\","
    "\"activeMarkerOffset\":%" PRIu64 ",\"frameByteLength\":%" PRIu64 ","
    "\"frameSha256\":\"%s\",\"head\":{\"generation\":\"%s\","
    "\"journalId\":\"%s\",\"schema\":\"" JOURNAL_HEAD_SCHEMA "\","
    "\"valueDigest\":\"%s\"},\"kind\":\"snapshot_restore\","
    "\"operationId\":\"%s\",\"payloadByteLength\":%" PRIu64 ","
    "\"payloadSha256\":\"%s\",\"projectId\":\"%s\",\"schema\":\""
    CREATE_JOURNAL_PHYSICAL_BINDING_SCHEMA "\",\"slot\":\"%c\"}",
    request->marker_length, request->marker_digest, request->marker_offset,
    request->frame_length, request->frame_digest, request->generation, request->journal_id,
    request->value_digest, request->create.operation, request->payload_length,
    request->payload_digest, escaped_project, request->slot);
  char binding_digest[72];
  bool valid = length > 0 && (size_t)length < sizeof(canonical) &&
    digest_domain(CREATE_JOURNAL_PHYSICAL_BINDING_SCHEMA, canonical, binding_digest) &&
    strcmp(binding_digest, request->binding_digest) == 0;
  static const size_t order[5] = { 2U, 4U, 0U, 3U, 1U };
  static const char *keys[5] = {
    "activeOperationId", "projectId", "activeKind", "nativePublication", "activeMarkerDigest"
  };
  size_t used = 0U;
  if (valid) canonical[0] = '\0';
  valid = valid && rollback_append(canonical, sizeof(canonical), &used, "{");
  for (size_t i = 0U; valid && i < 5U; i += 1U) {
    const CreateJournalSlice *slice = &request->slices[order[i]];
    valid = rollback_append(canonical, sizeof(canonical), &used,
      "%s\"%s\":{\"byteLength\":%" PRIu64 ",\"offset\":%" PRIu64
      ",\"rawSha256\":\"%s\",\"schema\":\"" CREATE_SLICE_SCHEMA "\"}",
      i == 0U ? "" : ",", keys[order[i]], slice->length, slice->offset, slice->digest);
  }
  valid = valid && rollback_append(canonical, sizeof(canonical), &used,
    ",\"schema\":\"" CREATE_SLICES_SCHEMA "\"}");
  char slices_digest[72];
  valid = valid && digest_domain(CREATE_SLICES_SCHEMA, canonical, slices_digest);
  length = valid ? snprintf(canonical, sizeof(canonical),
    "{\"bindingDigest\":\"%s\",\"command\":\"CREATE_MISSING\","
    "\"currentPayloadSlicesDigest\":\"%s\",\"operationId\":\"%s\","
    "\"preparedPublicationDigest\":\"%s\",\"requestDigest\":\"%s\","
    "\"schema\":\"" CREATE_COMMAND_SCHEMA "\"}", binding_digest, slices_digest,
    request->create.operation, request->publication_digest, request->request_digest) : -1;
  char command_digest[72];
  return valid && length > 0 && (size_t)length < sizeof(canonical) &&
    digest_domain(CREATE_COMMAND_SCHEMA, canonical, command_digest) &&
    strcmp(command_digest, request->command_digest) == 0;
}

static bool create_journal_frame_exact(
  RootBinding *root, CreateJournalRequest *request,
  const Identity *expected_journal_identity, Identity *journal_identity_out
) {
#ifdef WRITCRAFT_TEST_REQUIRE_CREATE_JOURNAL_BOUNDED_HASHES
  if (create_journal_command_active) create_journal_frame_full_hashes += 1U;
#endif
  char publication[4096];
  if (!create_journal_request_publication(request, publication, sizeof(publication)) ||
      !create_journal_command_authority(request)) {
    return false;
  }
  int journal_fd = openat(root->recovery_fd, JOURNAL_BASENAME,
    O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat journal_stat;
  Identity journal_identity;
  off_t slot_offset = request->slot == 'A' ? 0 : (off_t)JOURNAL_SLOT_CAPACITY;
  unsigned char *frame = malloc((size_t)request->frame_length);
  bool valid = journal_fd >= 0 && frame != NULL && fstat(journal_fd, &journal_stat) == 0 &&
    identity_from_stat(&journal_stat, &journal_identity) && S_ISREG(journal_stat.st_mode) &&
    journal_stat.st_uid == geteuid() && (journal_stat.st_mode & 0777) == 0600 &&
    journal_stat.st_nlink == 1 &&
    (expected_journal_identity == NULL ||
      same_file(expected_journal_identity, &journal_identity)) && record_path_matches_fd(
      root->recovery_fd, JOURNAL_BASENAME, journal_fd
    ) && create_journal_selected(journal_fd, request) && create_journal_read_all(
      journal_fd, frame, (size_t)request->frame_length, slot_offset
    );
  char observed_frame[72];
  if (valid) {
    sha256_prefixed(frame, (size_t)request->frame_length, observed_frame);
    valid = strcmp(observed_frame, request->frame_digest) == 0;
  }
  size_t newline = 0U;
  while (valid && newline < request->frame_length && newline < JOURNAL_MAX_HEADER_BYTES &&
      frame[newline] != '\n') newline += 1U;
  if (!valid || newline == 0U || newline >= request->frame_length ||
      newline >= JOURNAL_MAX_HEADER_BYTES) valid = false;
  char header[JOURNAL_MAX_HEADER_BYTES + 1U];
  char *fields[8];
  size_t field_count = 0U;
  uint64_t payload_length = 0U;
  if (valid) {
    memcpy(header, frame, newline); header[newline] = '\0';
    valid = split_fields(header, fields, 8U, &field_count) && field_count == 8U &&
      strcmp(fields[0], JOURNAL_MAGIC) == 0 && fields[1][0] == request->slot &&
      fields[1][1] == '\0' && strcmp(fields[2], request->journal_id) == 0 &&
      strcmp(fields[3], request->generation) == 0 &&
      parse_uint(fields[4], JOURNAL_MAX_VALUE_BYTES, &payload_length) &&
      payload_length == request->payload_length && strcmp(fields[5], request->value_digest) == 0 &&
      (strcmp(fields[6], "-") == 0 || valid_digest(fields[6])) &&
      strcmp(fields[7], request->payload_digest) == 0 &&
      request->frame_length == newline + 1U + request->payload_length;
  }
  unsigned char *payload = frame + newline + 1U;
  char observed_payload[72];
  if (valid) {
    sha256_prefixed(payload, (size_t)request->payload_length, observed_payload);
    valid = strcmp(observed_payload, request->payload_digest) == 0 &&
      payload[request->payload_length - 1U] == '\n';
  }
  char marker_digest[72];
  if (valid) create_journal_active_marker_digest(
    payload + request->marker_offset, (size_t)request->marker_length, marker_digest
  );
  char operation_json[80];
  char escaped_project[(MAX_PATH_BYTES * 2U) + 1U];
  char project_json[(MAX_PATH_BYTES * 2U) + 3U];
  char marker_json[80];
  int operation_length = snprintf(operation_json, sizeof(operation_json),
    "\"%s\"", request->create.operation);
  bool project_escaped = json_escape(request->project, escaped_project, sizeof(escaped_project));
  int project_length = project_escaped ? snprintf(project_json, sizeof(project_json),
    "\"%s\"", escaped_project) : -1;
  int marker_length = snprintf(marker_json, sizeof(marker_json), "\"%s\"", marker_digest);
  if (valid) {
    valid = strcmp(marker_digest, request->marker_digest) == 0 &&
      operation_length > 0 && project_length > 0 && marker_length > 0 &&
      create_journal_slice_exact(payload, &request->slices[0],
        (const unsigned char *)operation_json, (size_t)operation_length) &&
      create_journal_slice_exact(payload, &request->slices[1],
        (const unsigned char *)project_json, (size_t)project_length) &&
      create_journal_slice_exact(payload, &request->slices[2],
        (const unsigned char *)"\"snapshot_restore\"", 18U) &&
      create_journal_slice_exact(payload, &request->slices[3],
        (const unsigned char *)publication, strlen(publication)) &&
      create_journal_slice_exact(payload, &request->slices[4],
        (const unsigned char *)marker_json, (size_t)marker_length);
  }
  if (valid) {
    struct stat after_stat;
    Identity after_identity;
    valid = fsync(journal_fd) == 0 && fsync(root->recovery_fd) == 0 &&
      fstat(journal_fd, &after_stat) == 0 && identity_from_stat(&after_stat, &after_identity) &&
      same_file(&journal_identity, &after_identity) &&
      (expected_journal_identity == NULL ||
        same_file(expected_journal_identity, &after_identity)) &&
      record_path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, journal_fd) &&
      open_recovery(root, false) &&
      record_path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, journal_fd);
  }
  if (valid && journal_identity_out != NULL) *journal_identity_out = journal_identity;
  if (journal_fd >= 0) (void)close(journal_fd);
  free(frame);
  return valid;
}

static bool create_journal_guard_full(RootBinding *root, const CreateJournalGuard *guard) {
  Identity current_artifact;
  bool valid = guard != NULL && guard->request != NULL &&
    artifact_valid_bound(&guard->request->create, &current_artifact) &&
    same_file(&guard->artifact_identity, &current_artifact) && open_recovery(root, false) &&
    create_journal_frame_exact(
      root, guard->request, &guard->journal_identity, NULL
    );
#ifdef WRITCRAFT_TEST_REQUIRE_CREATE_JOURNAL_BOUNDED_HASHES
  if (valid) create_journal_full_verifications += 1U;
#endif
  return valid;
}

static bool create_journal_guard_cheap(RootBinding *root, const CreateJournalGuard *guard) {
  if (guard == NULL || guard->request == NULL ||
      !open_recovery(root, false)) {
    return false;
  }
  int artifact_flags = fcntl(HELD_ARTIFACT_FD, F_GETFL);
  struct stat artifact_stat;
  Identity artifact_identity;
  if (artifact_flags < 0 || (artifact_flags & O_ACCMODE) != O_RDONLY ||
      fstat(HELD_ARTIFACT_FD, &artifact_stat) != 0 ||
      !identity_from_stat(&artifact_stat, &artifact_identity) ||
      !same_file(&guard->artifact_identity, &artifact_identity) ||
      permission_mode(artifact_identity.mode) != 0600U || artifact_identity.nlink != 1U) {
    return false;
  }
  int journal_fd = openat(root->recovery_fd, JOURNAL_BASENAME,
    O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat journal_stat;
  Identity journal_identity;
  bool valid = journal_fd >= 0 && fstat(journal_fd, &journal_stat) == 0 &&
    identity_from_stat(&journal_stat, &journal_identity) &&
    same_file(&guard->journal_identity, &journal_identity) &&
    record_path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, journal_fd) &&
    create_journal_selected_cheap(journal_fd, guard->request) &&
    fstat(journal_fd, &journal_stat) == 0 &&
    identity_from_stat(&journal_stat, &journal_identity) &&
    same_file(&guard->journal_identity, &journal_identity) &&
    record_path_matches_fd(root->recovery_fd, JOURNAL_BASENAME, journal_fd) &&
    open_recovery(root, false);
  if (journal_fd >= 0) (void)close(journal_fd);
  return valid;
}

static bool create_journal_unknown(const CreateJournalRequest *request) {
  char payload[1024];
  int length = snprintf(payload, sizeof(payload),
    "{\"command\":\"CREATE_MISSING\",\"commandDigest\":\"%s\","
    "\"errorCode\":\"PUBLIC_MARKDOWN_NATIVE_UNKNOWN\",\"operationId\":\"%s\","
    "\"publicationResult\":null,\"schema\":\"" CREATE_JOURNAL_RESPONSE_SCHEMA
    "\",\"state\":\"UNKNOWN\"}\n", request->command_digest, request->create.operation);
  if (length <= 0 || (size_t)length >= sizeof(payload)) return false;
  char payload_digest[72];
  sha256_prefixed((const unsigned char *)payload, (size_t)length, payload_digest);
  char header[160];
  int header_length = snprintf(header, sizeof(header), "WRCCHPC2\t%d\t%s\n", length, payload_digest);
  return header_length > 0 && (size_t)header_length < sizeof(header) &&
    write_line(header) && write_line(payload);
}

static bool create_journal_committed(CreateJournalRequest *request) {
  char *payload = calloc(MAX_CREATE_JOURNAL_OUTPUT_BYTES + 1U, 1U);
  if (payload == NULL) return false;
  size_t used = 0U;
  bool valid = rollback_append(payload, MAX_CREATE_JOURNAL_OUTPUT_BYTES + 1U, &used,
    "{\"command\":\"CREATE_MISSING\",\"commandDigest\":\"%s\",\"errorCode\":null,"
    "\"operationId\":\"%s\",\"publicationResult\":{\"items\":[",
    request->command_digest, request->create.operation);
  for (size_t i = 0U; valid && i < request->create.count; i += 1U) {
    Item *item = &request->create.items[i];
    char control[MAX_RECORD_BYTES + 1U];
    char receipt[MAX_RECORD_BYTES + 1U];
    char escaped_selected[(MAX_SELECTED_BYTES * 2U) + 1U];
    RecordIdentity created_record;
    RecordIdentity control_record;
    RecordIdentity receipt_record;
    memset(&created_record, 0, sizeof(created_record));
    memset(&control_record, 0, sizeof(control_record));
    memset(&receipt_record, 0, sizeof(receipt_record));
    valid = item->created_identity_bound && item->control_identity_bound &&
      item->receipt_identity_bound && json_escape(
        item->selected, escaped_selected, sizeof(escaped_selected)
      ) && build_names_and_control(&request->create, item, control) &&
      build_receipt(&request->create, item, receipt);
    if (!valid) break;
    created_record.identity = item->created_identity;
    memcpy(created_record.content, item->content, DIGEST_BYTES + 1U);
    control_record.identity = item->control_identity;
    sha256_prefixed((const unsigned char *)control, strlen(control), control_record.content);
    receipt_record.identity = item->receipt_identity;
    sha256_prefixed((const unsigned char *)receipt, strlen(receipt), receipt_record.content);
    valid = rollback_append(payload, MAX_CREATE_JOURNAL_OUTPUT_BYTES + 1U, &used,
      "%s{\"controlRecordIdentity\":", i == 0U ? "" : ",") &&
      rollback_identity_json(
        payload, MAX_CREATE_JOURNAL_OUTPUT_BYTES + 1U, &used, &control_record
      ) && rollback_append(payload, MAX_CREATE_JOURNAL_OUTPUT_BYTES + 1U, &used,
        ",\"createdLeafIdentity\":") &&
      rollback_identity_json(
        payload, MAX_CREATE_JOURNAL_OUTPUT_BYTES + 1U, &used, &created_record
      ) && rollback_append(payload, MAX_CREATE_JOURNAL_OUTPUT_BYTES + 1U, &used,
        ",\"receiptRecordIdentity\":") &&
      rollback_identity_json(
        payload, MAX_CREATE_JOURNAL_OUTPUT_BYTES + 1U, &used, &receipt_record
      ) && rollback_append(payload, MAX_CREATE_JOURNAL_OUTPUT_BYTES + 1U, &used,
        ",\"selectedId\":\"%s\"}", escaped_selected);
  }
  valid = valid && rollback_append(payload, MAX_CREATE_JOURNAL_OUTPUT_BYTES + 1U, &used,
    "],\"operationId\":\"%s\",\"requestDigest\":\"%s\",\"schema\":"
    "\"writcraft.public-markdown-create-publication-result/v1\"},"
    "\"schema\":\"" CREATE_JOURNAL_RESPONSE_SCHEMA "\",\"state\":\"COMMITTED\"}\n",
    request->create.operation, request->request_digest);
  char payload_digest[72];
  if (valid) sha256_prefixed((const unsigned char *)payload, used, payload_digest);
  char header[160];
  int header_length = valid ? snprintf(
    header, sizeof(header), "WRCCHPC2\t%zu\t%s\n", used, payload_digest
  ) : -1;
  bool result = valid && header_length > 0 && (size_t)header_length < sizeof(header) &&
    write_line(header) && write_create_journal_payload(payload, used);
  free(payload);
  return result;
}

static bool create_journal_parse_and_run(RootBinding *root, char *line) {
#ifdef WRITCRAFT_TEST_REQUIRE_CREATE_JOURNAL_BOUNDED_HASHES
  create_journal_command_active = true;
  create_journal_artifact_full_hashes = 0U;
  create_journal_frame_full_hashes = 0U;
#endif
  CreateJournalRequest *request = calloc(1U, sizeof(*request));
  if (request == NULL || !create_journal_header(line, request)) {
    free(request); return false;
  }
  for (size_t i = 0U; i < request->create.count; i += 1U) {
    if (!read_protocol_line(line) || !parse_item(line, &request->create, i)) {
      free(request); return false;
    }
  }
  uint64_t selected_bytes = 0U;
  for (size_t i = 0U; i < request->create.count; i += 1U) {
    if (request->create.items[i].length > MAX_CREATE_JOURNAL_ARTIFACT_BYTES - selected_bytes) {
      free(request); return false;
    }
    selected_bytes += request->create.items[i].length;
  }
  Identity artifact_identity;
  if (!protocol_eof() || !artifact_valid_bound(&request->create, &artifact_identity) ||
      !open_recovery(root, false)) {
    free(request); return false;
  }
  Identity journal_identity;
  bool verified = create_journal_frame_exact(root, request, NULL, &journal_identity);
  bool result = false;
  if (verified) {
#ifdef WRITCRAFT_TEST_REQUIRE_CREATE_JOURNAL_BOUNDED_HASHES
    create_journal_full_verifications = 1U;
    create_journal_slice_hash_bytes = 0U;
#endif
    CreateJournalGuard guard = {
      .request = request,
      .artifact_identity = artifact_identity,
      .journal_identity = journal_identity,
    };
    request->create.command = 'C';
    create_journal_captured_state[0] = '\0';
    create_journal_capture = true;
    bool invoked = create_items(root, &request->create, &guard);
    create_journal_capture = false;
#ifdef WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_AFTER_COMMIT
    if (invoked && strcmp(create_journal_captured_state, "COMMITTED") == 0 &&
        !test_sync_point("create-journal-after-commit")) invoked = false;
#endif
    if (invoked && strcmp(create_journal_captured_state, "COMMITTED") == 0) {
      if (create_journal_guard_full(root, &guard)) {
#ifdef WRITCRAFT_TEST_REQUIRE_CREATE_JOURNAL_BOUNDED_HASHES
        if (create_journal_full_verifications != 2U ||
            create_journal_slice_hash_bytes != selected_bytes ||
            create_journal_artifact_full_hashes != 2U ||
            create_journal_frame_full_hashes != 2U) {
          result = create_journal_unknown(request);
        } else
#endif
        {
#ifdef WRITCRAFT_TEST_MALFORMED_CREATE_JOURNAL_RESPONSE
          result = create_journal_committed(request) && write_line("x");
#else
          result = create_journal_committed(request);
#endif
        }
      } else {
        result = create_journal_unknown(request);
      }
    } else {
      result = create_journal_unknown(request);
    }
  }
  free(request);
  return result;
}

int main(void) {
  RootBinding root;
  memset(&root, 0, sizeof(root));
  root.project_fd = -1;
  root.recovery_fd = -1;
  char line[MAX_LINE_BYTES + 2U];
  if (!read_protocol_line(line) || !bind_root(line, &root) || !read_protocol_line(line)) return 2;
  bool result = false;
  if (strncmp(line, "CJ\tCREATE_MISSING\t", 18U) == 0) {
    output_limit = MAX_CREATE_JOURNAL_OUTPUT_BYTES;
    result = create_journal_parse_and_run(&root, line);
  } else if ((line[0] == 'G' || line[0] == 'R' || line[0] == 'A') &&
      strncmp(line + 1U, "\tCREATE_CLEANUP\t", 16U) == 0) {
    CreateCleanupRequest request;
    memset(&request, 0, sizeof(request));
    if (!create_cleanup_header(line, &request)) return 3;
    for (size_t i = 0U; i < request.count; i += 1U) {
      if (!read_protocol_line(line) || !create_cleanup_item_line(line, &request, i)) return 3;
    }
    if (!protocol_eof()) return 3;
    result = run_create_cleanup(&root, &request);
  } else if ((line[0] == 'Q' || line[0] == 'R' || line[0] == 'D' || line[0] == 'A') &&
      strncmp(line + 1U, "\tCREATE_ROLLBACK\t", 17U) == 0) {
    output_limit = MAX_ROLLBACK_OUTPUT_BYTES;
    result = rollback_parse_and_run(&root, line);
  } else if ((line[0] == 'Q' && strncmp(line, "Q\tUNDO\t", 7U) == 0) ||
      (line[0] == 'R' && strncmp(line, "R\tUNDO\t", 7U) == 0)) {
    UndoRequest request;
    memset(&request, 0, sizeof(request));
    if (!undo_header(line, &request)) return 3;
    for (size_t i = 0U; i < request.count; i += 1U) {
      if (!read_protocol_line(line) || !undo_item_line(line, &request, i)) return 3;
    }
    if (!protocol_eof()) return 3;
    result = request.command == 'Q' ? undo_quarantine(&root, &request) :
      undo_reconcile(&root, &request);
  } else if ((line[0] == 'B' || line[0] == 'D') &&
      strncmp(line + 1U, "\tUNDO\t", 6U) == 0) {
    UndoRequest request;
    memset(&request, 0, sizeof(request));
    if (!undo_settle_header(line, &request)) return 3;
    for (size_t i = 0U; i < request.count; i += 1U) {
      if (!read_protocol_line(line) || !undo_token_line(line, &request, i)) return 3;
    }
    if (!protocol_eof()) return 3;
    result = undo_settle(&root, &request);
  } else if (line[0] == 'A' && strncmp(line, "A\tUNDO\t", 7U) == 0) {
    UndoRequest request;
    memset(&request, 0, sizeof(request));
    if (!undo_ack_header(line, &request)) return 3;
    for (size_t i = 0U; i < request.count; i += 1U) {
      if (!read_protocol_line(line) || !undo_token_line(line, &request, i)) return 3;
    }
    if (!protocol_eof()) return 3;
    result = undo_ack(&root, &request);
  } else if (line[0] == 'E' && strncmp(line + 1U, "\t", 1U) == 0) {
    output_limit = MAX_EXISTING_OUTPUT_BYTES;
    result = existing_execute_unknown(&root, line);
  } else if (line[0] == 'R' && strncmp(line + 1U, "\t", 1U) == 0 &&
      existing_reconcile_header_shape(line)) {
    output_limit = MAX_EXISTING_OUTPUT_BYTES;
    result = existing_reconcile_readonly(&root, line);
  } else if (line[0] == 'C' || line[0] == 'R') {
    Request request;
    memset(&request, 0, sizeof(request));
    if (!parse_request_header(line, &request)) return 3;
    for (size_t i = 0U; i < request.count; i += 1U) {
      if (!read_protocol_line(line) || !parse_item(line, &request, i)) return 3;
    }
    if (!protocol_eof()) return 3;
    result = request.command == 'C'
      ? create_items(&root, &request, NULL)
      : reconcile_items(&root, &request);
  } else if (line[0] == 'F' && strncmp(line + 1U, "\tPUBLISH\t", 9U) == 0) {
    output_limit = MAX_EXISTING_OUTPUT_BYTES;
    result = existing_finalize(&root, line);
  } else if (line[0] == 'F' && strncmp(line + 1U, "\tACK\t", 5U) == 0) {
    output_limit = MAX_EXISTING_OUTPUT_BYTES;
    result = existing_ack(&root, line);
  } else if (line[0] == 'F') {
    char *fields[7];
    size_t field_count = 0U;
    uint64_t item_count;
    if (!split_fields(line, fields, 7U, &field_count) || field_count != 7U || strcmp(fields[0], "F") != 0 ||
        !valid_operation(fields[1]) || !valid_digest(fields[2]) || !valid_digest(fields[3]) ||
        !valid_digest(fields[4]) || !valid_digest(fields[5]) ||
        !parse_uint(fields[6], MAX_ITEMS, &item_count) || item_count == 0U) return 3;
    char operation[64];
    char artifact[72];
    char selection[72];
    char history_phase[72];
    char receipt_set[72];
    memcpy(operation, fields[1], strlen(fields[1]) + 1U);
    memcpy(artifact, fields[2], DIGEST_BYTES + 1U);
    memcpy(selection, fields[3], DIGEST_BYTES + 1U);
    memcpy(history_phase, fields[4], DIGEST_BYTES + 1U);
    memcpy(receipt_set, fields[5], DIGEST_BYTES + 1U);
    Item items[MAX_ITEMS];
    memset(items, 0, sizeof(items));
    for (size_t i = 0U; i < (size_t)item_count; i += 1U) {
      if (!read_protocol_line(line) || !parse_token_line(line, &items[i])) return 3;
    }
    if (!protocol_eof()) return 3;
    result = finalize_items(&root, operation, artifact, selection, history_phase, receipt_set,
      items, (size_t)item_count);
  }
  if (root.project_fd >= 0) (void)close(root.project_fd);
  if (root.recovery_fd >= 0) (void)close(root.recovery_fd);
  return result ? 0 : 4;
}
