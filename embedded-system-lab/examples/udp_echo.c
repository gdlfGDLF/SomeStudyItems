#define _POSIX_C_SOURCE 200809L

#include "common.h"
#include <arpa/inet.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define MAX_MESSAGE 1024

static void usage(const char *name)
{
    fprintf(stderr, "Usage:\n  %s --server PORT [--bind IPv4] [--once] [--timeout-ms MS]\n"
            "  %s --client IPv4 PORT TEXT [--timeout-ms MS]\n"
            "Server binds 127.0.0.1 by default, idle timeout 30000 ms.\n"
            "Client timeout 2000 ms. Both limit messages to 1024 bytes.\n", name, name);
}

static int send_datagram(int fd, const unsigned char *bytes, size_t length,
                         const struct sockaddr_in *peer, int64_t deadline)
{
    for (;;) {
        int ready = wait_ready(fd, POLLOUT, deadline);
        if (ready <= 0) { if (!ready) errno = ETIMEDOUT; return -1; }
        ssize_t sent = sendto(fd, bytes, length, 0, (const struct sockaddr *)peer, sizeof(*peer));
        if (sent < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (sent < 0) return -1;
        if ((size_t)sent != length) { errno = EIO; return -1; }
        return 0;
    }
}

static int run_server(int fd, const struct sockaddr_in *local, int once, long timeout)
{
    if (bind(fd, (const struct sockaddr *)local, sizeof(*local)) < 0) { perror("bind"); return 1; }
    char address[INET_ADDRSTRLEN];
    if (!inet_ntop(AF_INET, &local->sin_addr, address, sizeof(address))) { perror("inet_ntop"); return 1; }
    printf("Listening on %s:%u (UDP application echo).\n", address, (unsigned int)ntohs(local->sin_port));
    fflush(stdout);
    while (!interrupted) {
        int64_t now = milliseconds();
        if (now < 0) { perror("clock_gettime"); return 1; }
        int64_t deadline = now + timeout;
        int ready = wait_ready(fd, POLLIN, deadline);
        if (!ready) { fprintf(stderr, "Server idle timeout.\n"); return 3; }
        if (ready < 0) { if (interrupted) break; perror("server poll"); return 1; }
        struct sockaddr_in peer;
        socklen_t peer_size = sizeof(peer);
        unsigned char data[MAX_MESSAGE];
        /* Linux MSG_TRUNC 提供原始报文长度，超大包拒绝回显而不回传截断内容。 */
        ssize_t length = recvfrom(fd, data, sizeof(data), MSG_TRUNC, (struct sockaddr *)&peer, &peer_size);
        if (length < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (length < 0) { perror("recvfrom"); return 1; }
        if (length > MAX_MESSAGE) { fprintf(stderr, "Ignored oversized datagram.\n"); continue; }
        if (peer_size != sizeof(peer) || peer.sin_family != AF_INET) continue;
        print_bytes("Received", data, (size_t)length);
        if (send_datagram(fd, data, (size_t)length, &peer, deadline) < 0) { perror("server sendto"); return 1; }
        puts("Application sent an echo; UDP itself has no ACK.");
        fflush(stdout);
        if (once) return 0;
    }
    return 130;
}

static int run_client(int fd, const struct sockaddr_in *peer, const char *text, long timeout)
{
    size_t length = strlen(text);
    int64_t now = milliseconds();
    if (now < 0) { perror("clock_gettime"); return 1; }
    int64_t deadline = now + timeout;
    if (send_datagram(fd, (const unsigned char *)text, length, peer, deadline) < 0) {
        int saved_errno = errno;
        perror("client sendto");
        return saved_errno == ETIMEDOUT ? 3 : 1;
    }
    print_bytes("Queued TX", (const unsigned char *)text, length);
    fflush(stdout);
    while (!interrupted) {
        int ready = wait_ready(fd, POLLIN, deadline);
        if (!ready) { fprintf(stderr, "Timed out waiting for application echo.\n"); return 3; }
        if (ready < 0) { if (interrupted) break; perror("client poll"); return 1; }
        unsigned char data[MAX_MESSAGE];
        struct sockaddr_in sender;
        socklen_t sender_size = sizeof(sender);
        ssize_t count = recvfrom(fd, data, sizeof(data), MSG_TRUNC, (struct sockaddr *)&sender, &sender_size);
        if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (count < 0) { perror("client recvfrom"); return 1; }
        /* 不把别的 IP 或端口发来的报文当作本次请求的回复。 */
        if (sender_size != sizeof(sender) || sender.sin_family != AF_INET ||
            sender.sin_addr.s_addr != peer->sin_addr.s_addr || sender.sin_port != peer->sin_port) {
            fprintf(stderr, "Ignored datagram from a different endpoint.\n"); continue;
        }
        if (count > MAX_MESSAGE || (size_t)count != length || memcmp(data, text, length)) {
            fprintf(stderr, "Reply does not match the request.\n"); return 4;
        }
        print_bytes("Application RX", data, (size_t)count);
        puts("Echo matches. sendto success alone did not prove delivery.");
        return 0;
    }
    return 130;
}

int main(int argc, char **argv)
{
    int server = 0, once = 0, next;
    long port, timeout;
    const char *address, *text = NULL;
    if (argc == 2 && !strcmp(argv[1], "--help")) { usage(argv[0]); return 0; }
    if (argc >= 3 && !strcmp(argv[1], "--server")) {
        server = 1; address = "127.0.0.1"; timeout = 30000; next = 3;
        if (parse_number(argv[2], 1, 65535, &port) < 0) { usage(argv[0]); return 2; }
    } else if (argc >= 5 && !strcmp(argv[1], "--client")) {
        address = argv[2]; text = argv[4]; timeout = 2000; next = 5;
        if (parse_number(argv[3], 1, 65535, &port) < 0 || !*text || strlen(text) > MAX_MESSAGE) { usage(argv[0]); return 2; }
    } else { usage(argv[0]); return 2; }
    for (int i = next; i < argc; ++i) {
        if (server && !strcmp(argv[i], "--once")) once = 1;
        else if (server && !strcmp(argv[i], "--bind") && i + 1 < argc) address = argv[++i];
        else if (!strcmp(argv[i], "--timeout-ms") && i + 1 < argc) {
            if (parse_number(argv[++i], 1, 60000, &timeout) < 0) { usage(argv[0]); return 2; }
        } else { usage(argv[0]); return 2; }
    }
    struct sockaddr_in endpoint = {.sin_family = AF_INET, .sin_port = htons((uint16_t)port)};
    if (inet_pton(AF_INET, address, &endpoint.sin_addr) != 1) { fprintf(stderr, "Provide a valid numeric IPv4 address.\n"); return 2; }
    if (install_signals() < 0) { perror("sigaction"); return 1; }
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) { perror("socket"); return 1; }
    int result = server ? run_server(fd, &endpoint, once, timeout) : run_client(fd, &endpoint, text, timeout);
    close(fd);
    return interrupted ? 130 : result;
}
