/*
 * The native sandbox helper.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.9 ("Native and
 * platform sandbox") observes that the pinned target's helper is a native
 * worker: "It reads `SRT_OBSERVE_SOCK` and `SRT_ENCODED_CMD`, creates a
 * socketpair, unshares PID/mount and user namespaces, forks, performs
 * private/root and `/proc` mounts, sets `prctl` (including
 * `PR_SET_NO_NEW_PRIVS`), installs a seccomp filter with
 * `SECCOMP_FILTER_FLAG_TSYNC_ESRCH` and a listener with
 * `SECCOMP_FILTER_FLAG_NEW_LISTENER`, transfers descriptors with `sendmsg`,
 * waits with `waitpid`, and finally `execvp`s."
 *
 * This program performs the same kernel work for this implementation:
 *
 *   - the namespace setup: `unshare(2)` into the user, mount, PID, IPC, UTS
 *     and network namespaces, with the user mapping written by the caller —
 *     the helper asks, waits, and proceeds;
 *   - the mount plan: every bind, every tmpfs mask, the private root and the
 *     fresh `/proc`, executed by a worker inside the new mount namespace,
 *     whose old tree is staged and detached after `pivot_root(2)`;
 *   - `prctl(PR_SET_NO_NEW_PRIVS)` before the seccomp filter is installed;
 *   - the seccomp filter compiled by the TypeScript launcher, read as raw
 *     classic-BPF instructions and installed with
 *     `SECCOMP_FILTER_FLAG_NEW_LISTENER`, whose notification descriptor is
 *     handed back the way the audited helper transfers descriptors with
 *     `sendmsg`;
 *   - the notification pump: the helper holds the kernel's listener, reads
 *     the notifications and carries frames between the kernel and the
 *     supervisor on the far end of the notifier socket — reading the target's
 *     memory, resolving its paths, re-validating a notification id, and
 *     answering a notification. Those are the calls a Node process cannot
 *     issue; the decisions are the supervisor's.
 *
 * The helper itself makes no security decisions: the deny list, the mount
 * plan and the observe-never-deny rule are the launcher's; this program is
 * the part that needs the kernel.
 *
 * Three deliberate properties, and why they hold:
 *
 *   - **No `.node` artifact.** This is a standalone ELF worker, run as a
 *     separate process and never registered with, or auto-imported by, the
 *     JavaScript loader. The build that compiles it refuses a `.node` output
 *     name, and this file is never linked as a native module.
 *   - **The seats are explicit.** One socket (the notifier, named in
 *     `SRT_OBSERVE_SOCK`) joins the pump to the supervisor; descriptors 3 and
 *     4 carry the plan document and the filter program; further descriptors,
 *     one per empty-file mask, carry the empty data the masks are bound over.
 *     Nothing else is read.
 *   - **Failure is loud.** Every namespace, mount, `prctl` and seccomp step
 *     that fails is announced with its errno on stderr and the helper exits
 *     non-zero; the launcher reports the refused step rather than a quieter
 *     sandbox.
 *
 * The seats, in the layout of the run:
 *
 *   helper main (the pump, host-side)
 *     `--fork-->` mounter: unshares the namespaces, asks for the uid map,
 *                forks the worker, waits, relays the worker's exit status
 *                  `--fork-->` worker: the first process of the new PID
 *                namespace: the mounts, `pivot_root`, the fresh `/proc`,
 *                `PR_SET_NO_NEW_PRIVS`, the filter and the listener, then
 *                `execve`s `/bin/sh -c <command>`
 *
 * `CLONE_NEWPID` does not move its caller, so the work that needs a process
 * *inside* the new PID namespace — the fresh `/proc` and the mounts that read
 * it — is the worker's, and the pump stays on the host side, where its pids
 * and its `/proc` are the ones the supervisor asks about.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif

/** `SECCOMP_FILTER_FLAG_NEW_LISTENER`: makes seccomp hand back a listener. */
#define SECCOMP_FLAG_NEW_LISTENER 0x8UL

/** `SECCOMP_IOCTL_NOTIF_RECV`: `SECCOMP_IOWR(0, struct seccomp_notif)`. */
#define SECCOMP_IOCTL_NOTIF_RECV_REQUEST 0xc0502100u

/** `SECCOMP_IOCTL_NOTIF_SEND`: `SECCOMP_IOWR(1, struct seccomp_notif_resp)`. */
#define SECCOMP_IOCTL_NOTIF_SEND_REQUEST 0xc0182101u

/** `SECCOMP_IOCTL_NOTIF_ID_VALID`: `SECCOMP_IOW(2, __u64)` (0 = still valid). */
#define SECCOMP_IOCTL_NOTIF_ID_VALID_REQUEST 0x40082102u

/** The kernel's own "the call may proceed" response flag. */
#define SECCOMP_USER_NOTIF_CONTINUE_FLAG 1u

/** The largest plan line the helper accepts, escaped. */
#define PLAN_LINE_MAX 32768

/** The largest filter the helper accepts, in instructions. */
#define FILTER_MAX_INSTRUCTIONS 16384

/** The largest read from the target's memory that one request carries. */
#define MEMORY_CHUNK_MAX 65536

/* ------------------------------------------------------------------ */
/* diagnostics                                                         */
/* ------------------------------------------------------------------ */

static void fail_step(const char *step) {
  fprintf(stderr, "sandbox-helper: %s failed (errno %d, %s)\n", step, errno,
          errno != 0 ? strerror(errno) : "no errno");
  _exit(3);
}

static void fail_where(const char *step, const char *what) {
  fprintf(stderr, "sandbox-helper: %s failed for %s (errno %d, %s)\n", step, what,
          errno, errno != 0 ? strerror(errno) : "no errno");
  _exit(3);
}

static void fail_said(const char *message) {
  fprintf(stderr, "sandbox-helper: %s\n", message);
  _exit(3);
}

/* ------------------------------------------------------------------ */
/* text: the escape one plan row may carry                             */
/* ------------------------------------------------------------------ */

/*
 * Path and value fields escape the characters a plan row cannot carry raw
 * — the row separators and a backslash itself — with the four-character
 * sequences `mount(8)` uses: a space is `\\040`, a tab `\\011`, a newline
 * `\\012` and a backslash `\\134`. Every field the plan carries passes
 * through this pair, so a path with a space does not end the field.
 */
static void unescape_field(const char *text, char *out, size_t out_size) {
  size_t used = 0;
  for (size_t i = 0; text[i] != '\0'; i++) {
    if (text[i] == '\\' && text[i + 1] != '\0' && text[i + 2] != '\0' && text[i + 3] != '\0') {
      const char *digits = &text[i + 1];
      unsigned int code = 0;
      if (sscanf(digits, "%o", &code) == 1) {
        if (used + 1 >= out_size) fail_said("a plan field is longer than the row allows");
        out[used++] = (char)code;
        i += 3;
        continue;
      }
    }
    if (used + 1 >= out_size) fail_said("a plan field is longer than the row allows");
    out[used++] = text[i];
  }
  out[used] = '\0';
}

/* ------------------------------------------------------------------ */
/* the plan                                                            */
/* ------------------------------------------------------------------ */

enum mount_kind {
  MOUNT_RO_BIND,
  MOUNT_BIND,
  MOUNT_TMPFS,
  MOUNT_PROC,
  MOUNT_DEV,
  MOUNT_DIR,
  MOUNT_EMPTY_FILE,
};

struct mount_step {
  enum mount_kind kind;
  char *target;
  /** The host source of a bind, or the descriptor number of an empty file. */
  char *source;
};

struct sandbox_plan {
  struct mount_step *mounts;
  size_t mount_count;
  char **environment;
  size_t environment_count;
  char *working_directory;
  char *token;
  char *command;
};

static void push_mount(struct sandbox_plan *plan) {
  struct mount_step *next = realloc(plan->mounts, (plan->mount_count + 1) * sizeof(*next));
  if (next == NULL) fail_step("plan-mount-grow");
  plan->mounts = next;
  memset(&plan->mounts[plan->mount_count], 0, sizeof(plan->mounts[0]));
  plan->mount_count++;
}

static void push_env(struct sandbox_plan *plan, const char *row) {
  char **next = realloc(plan->environment, (plan->environment_count + 1) * sizeof(char *));
  if (next == NULL) fail_step("plan-env-grow");
  plan->environment = next;
  char *copy = strdup(row);
  if (copy == NULL) fail_step("plan-env-strdup");
  plan->environment[plan->environment_count] = copy;
  plan->environment_count++;
}

static void plan_field(const char *raw, char *out, size_t out_size) {
  unescape_field(raw, out, out_size);
}

static void plan_owned_field(const char *raw, char **slot) {
  char decoded[PLAN_LINE_MAX];
  plan_field(raw, decoded, sizeof(decoded));
  char *copy = strdup(decoded);
  if (copy == NULL) fail_step("plan-field-strdup");
  *slot = copy;
}

/**
 * Read the plan from a descriptor. One action per line, in the order the
 * launcher compiled it; `#` starts a comment line. The order is the semantics:
 * a later row's mount wins over an earlier one on the same path, which is how
 * a mask beats the bind it covers.
 *
 * The rows are:
 *
 *   `M <kind> <target> [source]` — a mount. The kinds are `ro-bind`, `bind`,
 *       `tmpfs`, `proc`, `dev`, `dir` and `empty-file`; the first two carry a
 *       host source, `empty-file` carries the descriptor number to bind over
 *       the target.
 *   `E <name>=<value>`           — one filtered environment row.
 *   `C <working-directory>`      — the command's directory.
 *   `T <token>`                  — the readiness token.
 *   `X <command>`                — the command.
 */
static void read_plan(int fd, struct sandbox_plan *plan) {
  FILE *file = fdopen(fd, "r");
  if (file == NULL) fail_step("plan-fdopen");
  static char line[PLAN_LINE_MAX];
  while (fgets(line, sizeof(line), file) != NULL) {
    size_t length = strlen(line);
    while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r'))
      line[--length] = '\0';
    if (length == 0 || line[0] == '#') continue;

    if (line[0] == 'M' && line[1] == ' ') {
      push_mount(plan);
      struct mount_step *step = &plan->mounts[plan->mount_count - 1];
      char kind[24] = {0};
      char target[2 * PATH_MAX] = {0};
      char source[2 * PATH_MAX] = {0};
      const int read_count = sscanf(line, "M %23s %8188s %8188s", kind, target, source);
      if (read_count < 2) fail_said("a mount row is missing its fields");
      plan_owned_field(target, &step->target);
      if (read_count == 3) plan_owned_field(source, &step->source);
      if (step->target[0] != '/') fail_said("a mount row carries a relative target");
      if (strcmp(kind, "ro-bind") == 0) step->kind = MOUNT_RO_BIND;
      else if (strcmp(kind, "bind") == 0) step->kind = MOUNT_BIND;
      else if (strcmp(kind, "tmpfs") == 0) step->kind = MOUNT_TMPFS;
      else if (strcmp(kind, "proc") == 0) step->kind = MOUNT_PROC;
      else if (strcmp(kind, "dev") == 0) step->kind = MOUNT_DEV;
      else if (strcmp(kind, "dir") == 0) step->kind = MOUNT_DIR;
      else if (strcmp(kind, "empty-file") == 0) step->kind = MOUNT_EMPTY_FILE;
      else fail_said("a mount row carries an unknown kind");
      if ((step->kind == MOUNT_RO_BIND || step->kind == MOUNT_BIND ||
           step->kind == MOUNT_EMPTY_FILE) &&
          (step->source == NULL || step->source[0] == '\0'))
        fail_said("a bind row carries no source");
    } else if (line[0] == 'E' && line[1] == ' ') {
      char decoded[PLAN_LINE_MAX];
      plan_field(line + 2, decoded, sizeof(decoded));
      push_env(plan, decoded);
    } else if (line[0] == 'C' && line[1] == ' ') {
      plan_owned_field(line + 2, &plan->working_directory);
    } else if (line[0] == 'T' && line[1] == ' ') {
      plan_owned_field(line + 2, &plan->token);
    } else if (line[0] == 'X' && line[1] == ' ') {
      plan_owned_field(line + 2, &plan->command);
    } else {
      fail_said("a plan row is unknown");
    }
  }
  if (plan->command == NULL || plan->command[0] == '\0')
    fail_said("the plan carries no command");
  if (plan->token == NULL)
    fail_said("the plan carries no readiness token");
  if (plan->working_directory == NULL)
    fail_said("the plan carries no working directory");
  (void)fclose(file);
}

/* ------------------------------------------------------------------ */
/* the seccomp program                                                 */
/* ------------------------------------------------------------------ */

/**
 * The filter the launcher already compiled, read as raw classic-BPF
 * instructions whole, and validated just enough to hand to the kernel: the
 * length is a whole number of instructions and it fits.
 */
static void read_filter(int fd, struct sock_fprog *program) {
  static struct sock_filter instructions[FILTER_MAX_INSTRUCTIONS];
  const size_t want = sizeof(instructions);
  size_t got = 0;
  while (got < want) {
    const ssize_t n = read(fd, (char *)instructions + got, want - got);
    if (n == 0) break;
    if (n < 0) {
      if (errno == EINTR) continue;
      fail_step("filter-read");
    }
    got += (size_t)n;
  }
  if (got == 0) fail_said("the seccomp filter is empty");
  if (got % sizeof(struct sock_filter) != 0) fail_said("the seccomp filter length is whole only");
  program->len = (unsigned short)(got / sizeof(struct sock_filter));
  program->filter = instructions;
}

/* ------------------------------------------------------------------ */
/* the notifier line layer                                             */
/* ------------------------------------------------------------------ */

static void write_line(int fd, const char *line) {
  const size_t length = strlen(line);
  size_t wrote = 0;
  while (wrote < length) {
    const ssize_t n = write(fd, line + wrote, length - wrote);
    if (n < 0) {
      if (errno == EINTR) continue;
      fail_step("notifier-write");
    }
    wrote += (size_t)n;
  }
  if (write(fd, "\n", 1) != 1) fail_step("notifier-write-newline");
}

/**
 * Read one newline-terminated line into `buffer`. Returns the length, or
 * `-1` when the far end is gone.
 */
static ssize_t read_line(int fd, char *buffer, size_t size) {
  size_t got = 0;
  while (got < size - 1) {
    char c = 0;
    const ssize_t n = read(fd, &c, 1);
    if (n == 0) return got > 0 ? (ssize_t)got : -1;
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (c == '\n') break;
    buffer[got++] = c;
  }
  buffer[got] = '\0';
  return (ssize_t)got;
}

static void hex_of(char *out, size_t out_size, const unsigned char *bytes, size_t count) {
  static const char digits[] = "0123456789abcdef";
  size_t used = 0;
  for (size_t i = 0; i < count && used + 2 < out_size; i++) {
    out[used++] = digits[bytes[i] >> 4];
    out[used++] = digits[bytes[i] & 0x0f];
  }
  out[used] = '\0';
}

/* ------------------------------------------------------------------ */
/* the mount worker                                                    */
/* ------------------------------------------------------------------ */

/** The `dev` row: a tmpfs of the minimal node set, plus `/proc` symlinks. */
static void mount_dev(const char *target) {
  if (mount("tmpfs", target, "tmpfs", MS_NOSUID | MS_NODEV, "mode=755") != 0)
    fail_where("mount-dev", target);
  static const struct { const char *name; unsigned int major, minor; mode_t mode; } nodes[] = {
      { "null", 1, 3, S_IFCHR | 0666 },
      { "zero", 1, 5, S_IFCHR | 0666 },
      { "full", 1, 7, S_IFCHR | 0666 },
      { "random", 1, 8, S_IFCHR | 0666 },
      { "urandom", 1, 9, S_IFCHR | 0666 },
      { "tty", 5, 0, S_IFCHR | 0600 },
  };
  for (size_t i = 0; i < sizeof(nodes) / sizeof(nodes[0]); i++) {
    char path[PATH_MAX];
    if (snprintf(path, sizeof(path), "%s/%s", target, nodes[i].name) >= (int)sizeof(path))
      fail_where("mount-target", nodes[i].name);
    if (mknod(path, nodes[i].mode, makedev(nodes[i].major, nodes[i].minor)) != 0 && errno != EEXIST)
      fail_where("mknod", nodes[i].name);
  }
  static const struct { const char *name, *service; } symlinks[] = {
      { "stdin", "/proc/self/fd/0" },
      { "stdout", "/proc/self/fd/1" },
      { "stderr", "/proc/self/fd/2" },
      { "fd", "/proc/self/fd" },
  };
  for (size_t i = 0; i < sizeof(symlinks) / sizeof(symlinks[0]); i++) {
    char path[PATH_MAX];
    if (snprintf(path, sizeof(path), "%s/%s", target, symlinks[i].name) >= (int)sizeof(path))
      fail_where("mount-target", symlinks[i].name);
    if (symlink(symlinks[i].service, path) != 0 && errno != EEXIST)
      fail_where("symlink", symlinks[i].name);
  }
}

/** `mkdir -p` for every component of the path. */
static void make_tree(const char *path) {
  char buffer[PATH_MAX];
  if (snprintf(buffer, sizeof(buffer), "%s", path) >= (int)sizeof(buffer))
    fail_where("make-tree", path);
  for (char *p = buffer + 1; *p; p++) {
    if (*p == '/') {
      *p = '\0';
      if (mkdir(buffer, 0755) != 0 && errno != EEXIST) fail_where("mkdir", buffer);
      *p = '/';
    }
  }
  if (mkdir(buffer, 0755) != 0 && errno != EEXIST) fail_where("mkdir", buffer);
}

/** `mkdir -p` for the parent of the path, never the path itself. */
static void make_parent_tree(const char *path) {
  char buffer[PATH_MAX];
  if (snprintf(buffer, sizeof(buffer), "%s", path) >= (int)sizeof(buffer))
    fail_where("make-parent-tree", path);
  char *last = strrchr(buffer, '/');
  if (last == NULL || last == buffer) return; /* the root needs nothing */
  *last = '\0';
  make_tree(buffer);
}

/** The empty-file mask: a tmpfs-independent zero-byte file is bound over the target. */
static void mount_empty_file(const char *target, const char *source) {
  char *end = NULL;
  errno = 0;
  const long descriptor = strtol(source, &end, 10);
  if (end == source || *end != '\0' || descriptor <= 0 || descriptor > 1024)
    fail_said("an empty-file row carries a descriptor number it cannot read");
  char through[32];
  if (snprintf(through, sizeof(through), "/proc/self/fd/%ld", descriptor) >= (int)sizeof(through))
    fail_said("the empty-file source does not name a descriptor");
  make_parent_tree(target);
  if (mount(through, target, NULL, MS_BIND | MS_REC, NULL) != 0)
    fail_where("empty-file-bind", target);
  if (mount("none", target, NULL, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV, NULL) != 0)
    fail_where("empty-file-remount", target);
}

/** The path of a mount target inside the staging root. */
static void path_under(const char *root, const char *target, char *out, size_t out_size) {
  const int n = snprintf(out, out_size, "%s%s", root, target);
  if (n < 0 || (size_t)n >= out_size) fail_where("mount-target", target);
}

/**
 * Execute the mount plan inside the staging root, **in plan order**.
 *
 * The order is the semantics, the same one the launcher's plan documents: a
 * later row's mount wins over an earlier one on the same path, which is how a
 * mask beats the bind it covers. Each row makes its mount point first — inside
 * whatever is mounted there *now*, so a directory of a later bind is made on
 * the tmpfs that was mounted before it.
 */
static void worker_mounts(const struct sandbox_plan *plan, const char *new_root) {
  /* the mount tree is private, so nothing this root does leaks to the host */
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) fail_step("mount-private-root");
  /* the staging root: a tmpfs of its own, mounted on a directory the helper
   * created for this run */
  if (mount("tmpfs", new_root, "tmpfs", MS_NOSUID | MS_NODEV, "mode=755") != 0)
    fail_where("mount-new-root", new_root);

  char path[2 * PATH_MAX];
  for (size_t i = 0; i < plan->mount_count; i++) {
    const struct mount_step *step = &plan->mounts[i];
    switch (step->kind) {
      case MOUNT_RO_BIND:
      case MOUNT_BIND:
        path_under(new_root, step->target, path, sizeof(path));
        make_tree(path);
        if (mount(step->source, path, NULL, MS_BIND | MS_REC, NULL) != 0)
          fail_where("bind-mount", step->target);
        if (step->kind == MOUNT_RO_BIND) {
          if (mount("none", path, NULL,
                    MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_REC, NULL) != 0)
            fail_where("remount-readonly", step->target);
        }
        break;
      case MOUNT_TMPFS:
        path_under(new_root, step->target, path, sizeof(path));
        make_tree(path);
        if (mount("tmpfs", path, "tmpfs", MS_NOSUID | MS_NODEV, "mode=755") != 0)
          fail_where("tmpfs-mount", step->target);
        break;
      case MOUNT_PROC:
        path_under(new_root, step->target, path, sizeof(path));
        make_tree(path);
        if (mount("proc", path, "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0)
          fail_where("proc-mount", step->target);
        break;
      case MOUNT_DEV:
        path_under(new_root, step->target, path, sizeof(path));
        make_tree(path);
        mount_dev(path);
        break;
      case MOUNT_DIR:
        path_under(new_root, step->target, path, sizeof(path));
        make_tree(path);
        break;
      case MOUNT_EMPTY_FILE:
        path_under(new_root, step->target, path, sizeof(path));
        mount_empty_file(path, step->source);
        break;
      default:
        fail_said("the plan carries a mount kind the helper knows nothing about");
    }
  }

  /* the old tree is staged inside the new root and detached afterwards, so
   * nothing of the host is reachable once the command runs */
  char stage[PATH_MAX];
  if (snprintf(stage, sizeof(stage), "%s/oldstage", new_root) >= (int)sizeof(stage))
    fail_said("the staging path does not fit");
  if (mkdir(stage, 0755) != 0 && errno != EEXIST) fail_where("mkdir-stage", stage);
  if (chdir(new_root) != 0) fail_where("chdir-new-root", new_root);
  if (syscall(SYS_pivot_root, ".", "oldstage") != 0) fail_step("pivot-root");
  if (chdir("/") != 0) fail_step("chdir-root");
  if (umount2("/oldstage", MNT_DETACH) != 0) fail_step("detach-old-root");
}

/** The environment of the command: the plan's rows and the encoded command. */
static char **environ_of(const struct sandbox_plan *plan) {
  char **envp = calloc(plan->environment_count + 2, sizeof(char *));
  if (envp == NULL) fail_step("env-alloc");
  for (size_t i = 0; i < plan->environment_count; i++) envp[i] = plan->environment[i];
  return envp;
}

/** The worker: the mounts, `NO_NEW_PRIVS`, the filter and the listener, then exec. */
static void run_worker(int plan_fd, int filter_fd, const char *new_root, int handoff_fd) {
  struct sandbox_plan plan;
  memset(&plan, 0, sizeof(plan));
  read_plan(plan_fd, &plan);
  struct sock_fprog filter_program;
  read_filter(filter_fd, &filter_program);

  worker_mounts(&plan, new_root);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1UL, 0UL, 0UL, 0UL) != 0) fail_step("prctl-no-new-privs");
  const long listener = syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FLAG_NEW_LISTENER,
                                &filter_program);
  if (listener < 0) fail_step("seccomp-install-filter");

  /* the listener crosses the parent boundary the way the audited helper's
   * descriptors do: one byte, one control message */
  char handoff[1] = {'l'};
  struct iovec iov = { .iov_base = handoff, .iov_len = 1 };
  char control[CMSG_SPACE(sizeof(int))];
  memset(control, 0, sizeof(control));
  struct msghdr message = { .msg_iov = &iov, .msg_iovlen = 1,
                            .msg_control = control, .msg_controllen = sizeof(control) };
  struct cmsghdr *cmsg = CMSG_FIRSTHDR(&message);
  cmsg->cmsg_level = SOL_SOCKET;
  cmsg->cmsg_type = SCM_RIGHTS;
  cmsg->cmsg_len = CMSG_LEN(sizeof(int));
  const int listener_fd = (int)listener;
  memcpy(CMSG_DATA(cmsg), &listener_fd, sizeof(int));
  if (sendmsg(handoff_fd, &message, 0) < 1) fail_step("sendmsg-listener");
  (void)close((int)listener);

  /* the readiness token leaves before any command output */
  printf("%s", plan.token);
  if (fflush(stdout) != 0) fail_step("flush-token");

  /* the encoded command is the datum the target's helper carries; this
   * implementation base64-encodes the text the launcher compiled. */
  const char *encoded_prefix = "SRT_ENCODED_CMD=";
  const size_t command_length = strlen(plan.command);
  const size_t encoded_size = ((command_length + 2) / 3) * 4 + strlen(encoded_prefix) + 1;
  char *encoded = malloc(encoded_size);
  if (encoded == NULL) fail_step("encoded-alloc");

  /* the command runs under `/bin/sh -c`, carrying the plan's environment */
  char **envp = environ_of(&plan);
  envp[plan.environment_count] = encoded;

  /* every descriptor the helper owns is closed before the command runs */
  for (int fd = 3; fd < 1024; fd++) (void)close(fd);

  (void)umask(022);
  if (chdir(plan.working_directory) != 0) fail_where("chdir-working-directory", plan.working_directory);

  char *argv[4] = {(char *)"/bin/sh", (char *)"-c", plan.command, NULL};
  execve("/bin/sh", argv, envp);
  fail_step("execve-command");
}

/* ------------------------------------------------------------------ */
/* the seccomp probe (`--probe`)                                       */
/* ------------------------------------------------------------------ */

/**
 * Ask the kernel, in this process's own scope, what it permits: an
 * unprivileged user namespace, and a listener-carrying filter install under
 * `PR_SET_NO_NEW_PRIVS`. One JSON line on stdout; the exit status is 0 either
 * way — the *content* carries the verdict, and the launcher reads it.
 */
static int run_probe(void) {
  /* the real ids, captured before the unshare: after `CLONE_NEWUSER` the
   * process reads back the pre-map overflow id (65534), which is not what
   * the map is written from */
  const int real_uid = (int)getuid();
  const int real_gid = (int)getgid();
  const pid_t pid = fork();
  if (pid < 0) fail_step("probe-fork");
  if (pid == 0) {
    char verdict[128];
    if (unshare(CLONE_NEWUSER) != 0) {
      const int refused = errno;
      snprintf(verdict, sizeof(verdict),
               "{\"userns\":\"refused\",\"usernsErrno\":%d,\"attach\":\"refused\",\"attachErrno\":0}",
               refused);
      (void)!write(1, verdict, strlen(verdict));
      _exit(0);
    }
    char mapping[64];
    int flags = open("/proc/self/setgroups", O_WRONLY);
    if (flags >= 0) { (void)!write(flags, "deny\n", 5); (void)close(flags); }
    flags = open("/proc/self/uid_map", O_WRONLY);
    if (flags < 0) fail_step("probe-open-uid-map");
    if (snprintf(mapping, sizeof(mapping), "0 %d 1\n", real_uid) >= (int)sizeof(mapping))
      fail_said("the probe's uid map does not fit");
    if (write(flags, mapping, strlen(mapping)) < 0) fail_step("probe-write-uid-map");
    (void)close(flags);
    flags = open("/proc/self/gid_map", O_WRONLY);
    if (flags >= 0) {
      if (snprintf(mapping, sizeof(mapping), "0 %d 1\n", real_gid) >= (int)sizeof(mapping))
        fail_said("the probe's gid map does not fit");
      if (write(flags, mapping, strlen(mapping)) < 0) fail_step("probe-write-gid-map");
      (void)close(flags);
    }

    if (prctl(PR_SET_NO_NEW_PRIVS, 1UL, 0UL, 0UL, 0UL) != 0) fail_step("probe-prctl");

    /* The shape the launcher's filter already installs: one load, a jump
     * chain whose taken edge skips to the returns, the returns, then the
     * allow — a layout a conditional jump must not leap a load over. The
     * notified call is `openat`, the refused one is `mount`. */
    static struct sock_filter program[] = {
        { 0x20, 0, 0, 0 },                    /* load: the number */
        { 0x15, 0, 1, 257 },                  /* openat -> user notification */
        { 0x06, 0, 0, 0x7fc00000 },
        { 0x15, 0, 1, 165 },                  /* mount -> EPERM */
        { 0x06, 0, 0, 0x00050001 },
        { 0x06, 0, 0, 0x7fff0000 },           /* allow */
    };
    struct sock_fprog descriptor = { .len = 6, .filter = program };
    errno = 0;
    const long attached = syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FLAG_NEW_LISTENER,
                                  &descriptor);
    if (attached < 0) {
      const int refused = errno;
      snprintf(verdict, sizeof(verdict),
               "{\"userns\":\"ok\",\"usernsErrno\":0,\"attach\":\"refused\",\"attachErrno\":%d}",
               refused);
      (void)!write(1, verdict, strlen(verdict));
      _exit(0);
    }
    (void)!close((int)attached);
    static const char ok_verdict[] =
        "{\"userns\":\"ok\",\"usernsErrno\":0,\"attach\":\"ok\",\"attachErrno\":0}";
    (void)!write(1, ok_verdict, strlen(ok_verdict));
    _exit(0);
  }
  int status = 0;
  if (waitpid(pid, &status, 0) < 0) fail_step("probe-waitpid");
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) fail_step("probe-child");
  return 0;
}

/* ------------------------------------------------------------------ */
/* the pump                                                            */
/* ------------------------------------------------------------------ */

/**
 * Serve one notification and its surrounding frame traffic.
 *
 * The supervisor on the far end drives every decision; the pump is the kernel's
 * side: it reads the target's memory the supervisor asks for, resolves its
 * paths, re-validates a notification id and answers a notification. The frames
 * are one line each:
 *
 *   helper -> supervisor: `n <id> <pid> <nr> <args...>` and `x <exit-code>`,
 *     `D <hex|->` as the answer to an `M` frame, `T <path|->` as the answer to
 *     a `P` frame, `V <0|1>` as the answer to a `V` frame, `R ok` as the
 *     answer to an `R` frame;
 *   supervisor -> helper: `R <id> <error> <flags> <val>`, `V <id>`,
 *     `M <pid> <address-hex> <length-hex>`, `P <pid> <dirfd-auto-directory>` —
 *     `dirfd -100` meaning the target's own directory.
 */
static void serve_notification(int listener, int notifier, const struct seccomp_notif *note) {
  char frame[512];
  int written = snprintf(frame, sizeof(frame),
                         "n %llu %d %d %llu %llu %llu %llu %llu %llu",
                         (unsigned long long)note->id, note->pid, note->data.nr,
                         (unsigned long long)note->data.args[0], (unsigned long long)note->data.args[1],
                         (unsigned long long)note->data.args[2], (unsigned long long)note->data.args[3],
                         (unsigned long long)note->data.args[4], (unsigned long long)note->data.args[5]);
  if (written < 0 || (size_t)written >= sizeof(frame)) fail_said("the notification frame does not fit");
  write_line(notifier, frame);

  static char request[256];
  for (;;) {
    const ssize_t length = read_line(notifier, request, sizeof(request));
    if (length < 0) fail_step("notifier-read");
    if (request[0] == 'R' && request[1] == ' ') {
      unsigned long long id = 0;
      long long error = 0;
      unsigned int flags = 0;
      unsigned long long value = 0;
      if (sscanf(request, "R %llu %lld %u %llu", &id, &error, &flags, &value) != 4)
        fail_said("the supervisor's response carries the wrong number of fields");
      struct seccomp_notif_resp response;
      memset(&response, 0, sizeof(response));
      response.id = id;
      response.error = (int)error;
      response.flags = flags;
      response.val = (__s64)value;
      if (ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND_REQUEST, &response) != 0)
        fail_step("notif-send");
      write_line(notifier, "R ok");
      return;
    }
    if (request[0] == 'V' && request[1] == ' ') {
      unsigned long long id = 0;
      if (sscanf(request, "V %llu", &id) != 1) fail_said("the id check carries the wrong number of fields");
      errno = 0;
      const int valid = ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID_REQUEST, &id);
      write_line(notifier, valid == 0 ? "V 1" : "V 0");
      continue;
    }
    if (request[0] == 'M' && request[1] == ' ') {
      /* `M <pid> <address-hex> <length-hex>` */
      unsigned int targetPid = 0;
      char address[24] = {0};
      char length[16] = {0};
      if (sscanf(request, "M %u %23s %15s", &targetPid, address, length) != 3)
        fail_said("the memory request carries the wrong number of fields");
      unsigned char payload[MEMORY_CHUNK_MAX];
      /* the length is the count itself, written in hexadecimal text */
      const size_t count = (size_t)strtoull(length, NULL, 16);
      if (count == 0 || count > sizeof(payload))
        fail_said("the memory request is larger than the pump carries");
      const unsigned long long address_value = strtoull(address, NULL, 16);
      struct iovec local = { .iov_base = payload, .iov_len = count };
      struct iovec remote = { .iov_base = (void *)(uintptr_t)address_value, .iov_len = count };
      const ssize_t read_back = syscall(SYS_process_vm_readv, (pid_t)targetPid, &local, 1, &remote, 1, 0);
      if (read_back <= 0) {
        write_line(notifier, "D -");
        continue;
      }
      char *hex = malloc(2 * (size_t)read_back + 1);
      if (hex == NULL) fail_step("hex-alloc");
      hex_of(hex, 2 * (size_t)read_back + 1, payload, (size_t)read_back);
      char *reply = malloc(strlen(hex) + 4);
      if (reply == NULL) fail_step("hex-reply-alloc");
      snprintf(reply, strlen(hex) + 4, "D %s", hex);
      write_line(notifier, reply);
      free(hex);
      free(reply);
      continue;
    }
    if (request[0] == 'P' && request[1] == ' ') {
      /* `P <pid> <dirfd>`: the target's own directory, or one of its fds */
      unsigned int targetPid = 0;
      int dirfd = 0;
      if (sscanf(request, "P %u %d", &targetPid, &dirfd) != 2)
        fail_said("the path request carries the wrong number of fields");
      char link[PATH_MAX];
      if (dirfd == -100)
        snprintf(link, sizeof(link), "/proc/%u/cwd", targetPid);
      else
        snprintf(link, sizeof(link), "/proc/%u/fd/%d", targetPid, dirfd);
      char target[PATH_MAX];
      const ssize_t resolved = readlink(link, target, sizeof(target) - 1);
      if (resolved < 0 || (size_t)resolved >= sizeof(target) - 1 || target[0] != '/') {
        write_line(notifier, "T -");
        continue;
      }
      target[resolved] = '\0';
      char *reply = malloc(strlen(target) + 4);
      if (reply == NULL) fail_step("path-reply-alloc");
      snprintf(reply, strlen(target) + 4, "T %s", target);
      write_line(notifier, reply);
      free(reply);
      continue;
    }
    fprintf(stderr, "sandbox-helper: a supervisor request was not recognised: %s\n", request);
    write_line(notifier, "E unknown-request");
  }
}

/**
 * The pump: watch the kernel's listener, the supervisor's socket and the
 * mounter's handoff pair, and carry frames between the two until the sandbox
 * ends.
 */
static int run_pump(int listener, int notifier, int handoff) {
  static char line[PLAN_LINE_MAX];
  int exit_code = -1;
  for (;;) {
    struct pollfd watch[3] = {
        { .fd = listener, .events = POLLIN },
        { .fd = notifier, .events = POLLIN },
        { .fd = handoff, .events = POLLIN },
    };
    const int ready = poll(watch, 3, 60000);
    if (ready < 0) {
      if (errno == EINTR) continue;
      fail_step("pump-poll");
    }
    if (ready == 0) continue;
    if ((watch[0].revents & POLLIN) != 0) {
      struct seccomp_notif note;
      memset(&note, 0, sizeof(note));
      if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV_REQUEST, &note) != 0) {
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
        /* the target is gone: no more notifications can arrive */
      } else {
        serve_notification(listener, notifier, &note);
      }
    }
    if ((watch[1].revents & POLLIN) != 0) {
      const ssize_t length = read_line(notifier, line, sizeof(line));
      if (length < 0) fail_step("notifier-read");
      if (length > 0) {
        fprintf(stderr, "sandbox-helper: a stray supervisor line: %s\n", line);
        write_line(notifier, "E stray");
      }
    }
    if ((watch[2].revents & POLLIN) != 0) {
      /* the mounter relayed the exit status */
      char payload[2] = {0, 0};
      const ssize_t got = read(handoff, payload, sizeof(payload));
      if (got == 2 && payload[0] == 'x') {
        exit_code = (unsigned char)payload[1];
        break;
      }
      if (got <= 0) { exit_code = 0; break; }
    }
    if ((watch[2].revents & (POLLHUP | POLLERR)) != 0) break;
    if ((watch[1].revents & (POLLHUP | POLLERR)) != 0) break;
  }
  return exit_code;
}

/* ------------------------------------------------------------------ */
/* the notifier socket                                                 */
/* ------------------------------------------------------------------ */

/**
 * Connect the notifier socket. The address is the launcher's abstract
 * namespace name, named in `SRT_OBSERVE_SOCK` — the datum the audited helper
 * reads — so nothing lands on the filesystem and nothing is left to clean up.
 */
static int connect_notifier(void) {
  const char *name = getenv("SRT_OBSERVE_SOCK");
  if (name == NULL || name[0] == '\0')
    fail_said("SRT_OBSERVE_SOCK carries no socket name");
  const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) fail_step("notifier-socket");
  if (name[0] != '@')
    fail_said("SRT_OBSERVE_SOCK does not carry an abstract namespace name");
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  /* an abstract name: the first byte is NUL and the string is not NUL-padded */
  const size_t length = strlen(name + 1);
  if (length == 0 || length + 1 > sizeof(address.sun_path) - 1)
    fail_said("SRT_OBSERVE_SOCK's name does not fit the socket address");
  memcpy(address.sun_path + 1, name + 1, length);
  const socklen_t size =
      (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + length);
  if (connect(fd, (const struct sockaddr *)&address, size) != 0) fail_step("notifier-connect");
  return fd;
}

/* ------------------------------------------------------------------ */
/* the handoff pair                                                    */
/* ------------------------------------------------------------------ */

/**
 * Read one seqpacket message of the handoff pair: one byte, optionally
 * followed by a descriptor. Returns the byte, or `0` when the peer is gone.
 */
static char recv_handoff(int fd, int *fd_out) {
  char code = 0;
  struct iovec iov = { .iov_base = &code, .iov_len = 1 };
  char control[CMSG_SPACE(sizeof(int))];
  memset(control, 0, sizeof(control));
  struct msghdr message = { .msg_iov = &iov, .msg_iovlen = 1,
                            .msg_control = control, .msg_controllen = sizeof(control) };
  const ssize_t n = recvmsg(fd, &message, 0);
  if (fd_out != NULL) *fd_out = -1;
  if (n < 1) return 0;
  if (fd_out != NULL) {
    for (struct cmsghdr *cmsg = CMSG_FIRSTHDR(&message); cmsg; cmsg = CMSG_NXTHDR(&message, cmsg)) {
      if (cmsg->cmsg_level == SOL_SOCKET && cmsg->cmsg_type == SCM_RIGHTS)
        memcpy(fd_out, CMSG_DATA(cmsg), sizeof(int));
    }
  }
  return code;
}

static void send_handoff(int fd, const char *bytes, size_t length, int fd_to_send) {
  struct iovec iov = { .iov_base = (void *)bytes, .iov_len = length };
  char control[CMSG_SPACE(sizeof(int))];
  struct msghdr message = { .msg_iov = &iov, .msg_iovlen = 1,
                            .msg_control = NULL, .msg_controllen = 0 };
  if (fd_to_send >= 0) {
    memset(control, 0, sizeof(control));
    message.msg_control = control;
    message.msg_controllen = sizeof(control);
    struct cmsghdr *cmsg = CMSG_FIRSTHDR(&message);
    cmsg->cmsg_level = SOL_SOCKET;
    cmsg->cmsg_type = SCM_RIGHTS;
    cmsg->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(cmsg), &fd_to_send, sizeof(int));
  }
  if (sendmsg(fd, &message, 0) < 1) fail_step("handoff-send");
}

/* ------------------------------------------------------------------ */
/* the sandbox run                                                     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* the sandbox run                                                     */
/* ------------------------------------------------------------------ */

/**
 * The run: drive the plan and serve the notifications until the end.
 *
 * The mount point the staging tree is mounted on is a directory the helper
 * created for this run — `/tmp/.sandbox-helper-root-<pid>`, removed at the
 * end. It is not a protected path of the plan: it is the `pivot_root(2)`
 * staging point, one directory the launcher names as created for the run.
 */
static int run_sandbox(void) {
  int plan_fd = 3;  /* the plan document */
  int filter_fd = 4; /* the filter program */
  struct stat plan_status;
  if (fstat(plan_fd, &plan_status) != 0) fail_step("plan-open");

  const int notifier = connect_notifier();

  char new_root[PATH_MAX];
  if (snprintf(new_root, sizeof(new_root), "/tmp/.sandbox-helper-root-%d", (int)getpid()) >=
      (int)sizeof(new_root))
    fail_said("the staging root path does not fit");
  if (mkdir(new_root, 0755) != 0 && errno != EEXIST) fail_where("mkdir-new-root", new_root);

  /* The pair joins the pump to the mounter: the map request, the listener and
   * the exit status cross it, one seqpacket message at a time. */
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, pair) != 0) fail_step("socketpair");

  const pid_t mounter = fork();
  if (mounter < 0) fail_step("fork-mounter");
  if (mounter == 0) {
    /* the mounter: unshares, asks for the uid map, forks the worker */
    (void)close(pair[0]);
    (void)close(notifier);
    (void)close(plan_fd);
    (void)close(filter_fd);
    if (unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS |
                CLONE_NEWNET) != 0)
      fail_step("unshare-namespaces");

    /* the map request: the launcher writes the user map while we wait */
    send_handoff(pair[1], "m", 1, -1);
    if (recv_handoff(pair[1], NULL) != 'a') fail_step("recv-map-ack");

    (void)close(plan_fd);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) fail_step("pdeathsig-mounter");
    const pid_t worker = fork();
    if (worker < 0) fail_step("fork-worker");
    if (worker == 0) {
      /* the first process of the new PID namespace: the mounts, the proc
       * mount, the filter and the listener */
      if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) fail_step("pdeathsig-worker");
      run_worker(plan_fd, filter_fd, new_root, pair[1]);
      /* unreachable: the worker execs or fails */
      _exit(3);
    }
    int status = 0;
    if (waitpid(worker, &status, 0) < 0) fail_step("waitpid-worker");
    unsigned char code = 0;
    if (WIFEXITED(status)) code = (unsigned char)(WEXITSTATUS(status) & 0xff);
    else if (WIFSIGNALED(status)) code = (unsigned char)((128 + WTERMSIG(status)) & 0xff);
    const char relay[2] = { 'x', (char)code };
    send_handoff(pair[1], relay, 2, -1);
    _exit(0);
  }
  (void)close(pair[1]);

  /* the map request arrives before the listener does */
  if (recv_handoff(pair[0], NULL) != 'm') fail_step("recv-map-request");
  {
    char path[64];
    if (snprintf(path, sizeof(path), "/proc/%d/setgroups", (int)mounter) >= (int)sizeof(path))
      fail_said("the setgroups path does not fit");
    int f = open(path, O_WRONLY);
    if (f < 0) fail_where("setgroups-open", path);
    if (write(f, "deny\n", 5) < 0) fail_where("setgroups-write", path);
    (void)close(f);
    if (snprintf(path, sizeof(path), "/proc/%d/uid_map", (int)mounter) >= (int)sizeof(path))
      fail_said("the uid_map path does not fit");
    f = open(path, O_WRONLY);
    if (f < 0) fail_where("uid-map-open", path);
    char mapping[96];
    if (snprintf(mapping, sizeof(mapping), "0 %ld 1\n", (long)getuid()) >= (int)sizeof(mapping))
      fail_said("the uid map does not fit");
    if (write(f, mapping, strlen(mapping)) < 0) fail_where("uid-map-write", path);
    (void)close(f);
    if (snprintf(path, sizeof(path), "/proc/%d/gid_map", (int)mounter) >= (int)sizeof(path))
      fail_said("the gid_map path does not fit");
    f = open(path, O_WRONLY);
    if (f < 0) fail_where("gid-map-open", path);
    if (snprintf(mapping, sizeof(mapping), "0 %ld 1\n", (long)getgid()) >= (int)sizeof(mapping))
      fail_said("the gid map does not fit");
    if (write(f, mapping, strlen(mapping)) < 0) fail_where("gid-map-write", path);
    (void)close(f);
    send_handoff(pair[0], "a", 1, -1);
  }

  /* the worker's listener arrives through the pair */
  int listener = -1;
  if (recv_handoff(pair[0], &listener) != 'l' || listener < 0) fail_step("recv-listener");

  const int exit_code = run_pump(listener, notifier, pair[0]);
  if (exit_code >= 0) {
    char relay[16];
    if (snprintf(relay, sizeof(relay), "x %d", exit_code) >= (int)sizeof(relay))
      fail_said("the exit relay does not fit");
    write_line(notifier, relay);
  }
  (void)close(listener);
  (void)close(notifier);
  (void)close(pair[0]);

  int mounter_status = 0;
  (void)waitpid(mounter, &mounter_status, 0);
  if (rmdir(new_root) != 0) {
    /* the staging directory may still be a mount point in a mount namespace
     * of its own; the directory is one empty entry in the scratch area */
  }
  return exit_code >= 0 ? exit_code : 0;
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    printf("sandbox-helper 1.0.0\n");
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) return run_probe();
  if (argc == 1) return run_sandbox();
  fprintf(stderr, "sandbox-helper: usage: sandbox-helper [--version|--probe]\n");
  return 2;
}
