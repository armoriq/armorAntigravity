// agd-hook: the program Antigravity runs on every hook event.
//
// It takes the event from argv[1] and the payload from stdin, sends one frame to armoriq-agd over its
// unix socket, and writes the single line that comes back. It never builds a response of its own: when
// the daemon cannot answer, it writes the file the daemon pre-rendered for that event, and if that file
// is missing it falls back to the compiled-in deny below. Keeping the response rendering in the daemon
// is what lets this be C, which is what keeps the install a few megabytes instead of sixty.
//
// Only stdout carries meaning to Antigravity, so nothing else is ever written there, and the exit status
// is always 0: a non-zero exit makes agy treat the hook as failed.
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

// Mirrors packages/protocol: HOOK_FRAME_TAG, the budgets agd-hook's TypeScript predecessor used, and
// hookResponseLine(fallbackResponse("PreToolUse", "enforce", DAEMON_UNAVAILABLE_CODE, DAEMON_UNAVAILABLE_REASON)).
// packages/hook/test/client.test.ts holds the C and the TypeScript against each other.
#define FRAME_TAG "agd1"
#define START_BUDGET_MS 3000
#define RESPONSE_BUDGET_MS 10000
#define RETRY_MS 10
#define ENFORCE_DENY "{\"decision\":\"deny\",\"reason\":\"ArmorIQ blocked this call [daemon_unavailable]: armoriq-agd is not running or did not answer\"}\n"
#define MAX_REPLY_BYTES (4 * 1024 * 1024)

static const char *const EVENTS[] = {"PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"};

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} Buffer;

static int reserve(Buffer *b, size_t extra) {
  if (b->len + extra <= b->cap) return 1;
  size_t cap = b->cap ? b->cap : 64 * 1024;
  while (cap < b->len + extra) cap *= 2;
  char *grown = realloc(b->data, cap);
  if (!grown) return 0;
  b->data = grown;
  b->cap = cap;
  return 1;
}

static int append(Buffer *b, const char *src, size_t n) {
  if (!reserve(b, n)) return 0;
  memcpy(b->data + b->len, src, n);
  b->len += n;
  return 1;
}

static void write_all(int fd, const char *data, size_t n) {
  while (n > 0) {
    ssize_t wrote = write(fd, data, n);
    if (wrote > 0) {
      data += wrote;
      n -= (size_t)wrote;
    } else if (wrote < 0 && errno == EINTR) {
      continue;
    } else {
      return;
    }
  }
}

static long monotonic_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

static long long wall_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

static int known_event(const char *event) {
  for (size_t i = 0; i < sizeof EVENTS / sizeof EVENTS[0]; i++)
    if (strcmp(event, EVENTS[i]) == 0) return 1;
  return 0;
}

static const char *env_value(const char *name) {
  const char *value = getenv(name);
  if (!value) return NULL;
  while (*value == ' ' || *value == '\t') value++;
  return *value ? value : NULL;
}

// Leading ~/ only, matching the daemon's own path resolution.
static int expand_home(const char *path, char *out, size_t size) {
  if (path[0] != '~' || (path[1] != '/' && path[1] != '\0')) return snprintf(out, size, "%s", path) < (int)size;
  const char *home = getenv("HOME");
  return snprintf(out, size, "%s%s", home ? home : "", path + 1) < (int)size;
}

static int resolve_socket(char *out, size_t size) {
  const char *configured = env_value("ARMORANTIGRAVITY_SOCKET");
  if (configured) return expand_home(configured, out, size);
  const char *armoriq_home = env_value("ARMORIQ_HOME");
  if (armoriq_home) return snprintf(out, size, "%s/armorantigravity/agd.sock", armoriq_home) < (int)size;
  const char *home = getenv("HOME");
  return snprintf(out, size, "%s/.armoriq/armorantigravity/agd.sock", home ? home : "") < (int)size;
}

static int executable_dir(char *out, size_t size) {
  char path[PATH_MAX];
#ifdef __APPLE__
  uint32_t len = sizeof path;
  if (_NSGetExecutablePath(path, &len) != 0) return 0;
#else
  ssize_t len = readlink("/proc/self/exe", path, sizeof path - 1);
  if (len <= 0) return 0;
  path[len] = '\0';
#endif
  char *slash = strrchr(path, '/');
  if (!slash) return 0;
  *slash = '\0';
  return snprintf(out, size, "%s", path) < (int)size;
}

// A second daemon started by a concurrent hook exits on the instance lock, so racing here is safe.
static void spawn_daemon(void) {
  char path[PATH_MAX];
  const char *bin = env_value("ARMORANTIGRAVITY_DAEMON");
  if (!bin) {
    char dir[PATH_MAX];
    if (!executable_dir(dir, sizeof dir) || snprintf(path, sizeof path, "%s/armoriq-agd", dir) >= (int)sizeof path) return;
    bin = path;
  }
  pid_t pid = fork();
  if (pid != 0) return;
  setsid();
  int devnull = open("/dev/null", O_RDWR);
  if (devnull >= 0) {
    dup2(devnull, STDIN_FILENO);
    dup2(devnull, STDOUT_FILENO);
    dup2(devnull, STDERR_FILENO);
    if (devnull > STDERR_FILENO) close(devnull);
  }
  char *const args[] = {(char *)bin, NULL};
  execv(bin, args);
  _exit(127);
}

// The daemon writes one file per event holding the exact bytes to print. Missing or unreadable fails
// closed, which for a tool call means the deny above and for every other event means printing nothing.
static int print_fallback(const char *socket_path, const char *event) {
  char path[PATH_MAX];
  const char *slash = strrchr(socket_path, '/');
  size_t dir_len = slash ? (size_t)(slash - socket_path) : 0;
  int ok = snprintf(path, sizeof path, "%.*s/fallback/%s", (int)dir_len, socket_path, event) < (int)sizeof path;
  int fd = ok ? open(path, O_RDONLY) : -1;
  if (fd < 0) {
    if (strcmp(event, "PreToolUse") == 0) write_all(STDOUT_FILENO, ENFORCE_DENY, sizeof ENFORCE_DENY - 1);
    return 0;
  }
  char chunk[4096];
  for (;;) {
    ssize_t got = read(fd, chunk, sizeof chunk);
    if (got > 0) write_all(STDOUT_FILENO, chunk, (size_t)got);
    else if (got < 0 && errno == EINTR) continue;
    else break;
  }
  close(fd);
  return 0;
}

static int connect_socket(const char *socket_path) {
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  // sun_path is 104 bytes on macOS, and a temp directory under /var/folders reaches exactly that, so the
  // address length is computed rather than fixed: a path that fills sun_path travels without a terminator.
  size_t len = strlen(socket_path);
  if (len > sizeof addr.sun_path) return -1;
  memcpy(addr.sun_path, socket_path, len);
  socklen_t size = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + len + (len < sizeof addr.sun_path ? 1 : 0));
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  if (connect(fd, (struct sockaddr *)&addr, size) == 0) return fd;
  close(fd);
  return -1;
}

// Retries for START_BUDGET_MS, spawning the daemon once, the way hooks.json's timeout assumes.
static int dial(const char *socket_path) {
  long deadline = monotonic_ms() + START_BUDGET_MS;
  int spawned = 0;
  for (;;) {
    int fd = connect_socket(socket_path);
    if (fd >= 0) return fd;
    if (monotonic_ms() >= deadline) return -1;
    if (!spawned) {
      spawned = 1;
      spawn_daemon();
    }
    struct timespec nap = {0, RETRY_MS * 1000000L};
    nanosleep(&nap, NULL);
  }
}

// One line in, one line out. An empty line is the null response, which Antigravity must not see printed.
static int exchange(int fd, const Buffer *request, Buffer *reply) {
  long deadline = monotonic_ms() + RESPONSE_BUDGET_MS;
  write_all(fd, request->data, request->len);
  for (;;) {
    long remaining = deadline - monotonic_ms();
    if (remaining <= 0) return 0;
    struct pollfd p = {.fd = fd, .events = POLLIN};
    int ready = poll(&p, 1, (int)remaining);
    if (ready < 0) {
      if (errno == EINTR) continue;
      return 0;
    }
    if (ready == 0) return 0;
    if (!reserve(reply, 4096)) return 0;
    ssize_t got = read(fd, reply->data + reply->len, reply->cap - reply->len);
    if (got < 0) {
      if (errno == EINTR) continue;
      return 0;
    }
    if (got == 0) return 0;
    reply->len += (size_t)got;
    char *nl = memchr(reply->data, '\n', reply->len);
    if (nl) {
      reply->len = (size_t)(nl - reply->data);
      return 1;
    }
    if (reply->len > MAX_REPLY_BYTES) return 0;
  }
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  const char *event = argc > 1 ? argv[1] : "";
  if (!known_event(event)) return 0;

  char socket_path[PATH_MAX];
  if (!resolve_socket(socket_path, sizeof socket_path)) return print_fallback("", event);

  // The payload goes to the daemon exactly as Antigravity wrote it, so the hook needs no JSON writer.
  // JSON never has a bare newline inside a token, so turning newlines into spaces keeps the frame on
  // one line without changing what the daemon parses.
  Buffer request = {0};
  char header[64 + PATH_MAX];
  int header_len = snprintf(header, sizeof header, "%s %s %lld ", FRAME_TAG, event, wall_ms());
  if (!append(&request, header, (size_t)header_len)) return print_fallback(socket_path, event);
  for (;;) {
    if (!reserve(&request, 64 * 1024)) return print_fallback(socket_path, event);
    ssize_t got = read(STDIN_FILENO, request.data + request.len, request.cap - request.len);
    if (got > 0) {
      for (ssize_t i = 0; i < got; i++)
        if (request.data[request.len + (size_t)i] == '\n') request.data[request.len + (size_t)i] = ' ';
      request.len += (size_t)got;
    } else if (got < 0 && errno == EINTR) {
      continue;
    } else {
      break;
    }
  }
  if (!append(&request, "\n", 1)) return print_fallback(socket_path, event);

  int fd = dial(socket_path);
  if (fd < 0) return print_fallback(socket_path, event);
  Buffer reply = {0};
  int answered = exchange(fd, &request, &reply);
  close(fd);
  if (!answered) return print_fallback(socket_path, event);
  if (reply.len > 0) {
    append(&reply, "\n", 1);
    write_all(STDOUT_FILENO, reply.data, reply.len);
  }
  return 0;
}
