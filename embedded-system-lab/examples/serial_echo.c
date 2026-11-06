#define _DEFAULT_SOURCE
#define _POSIX_C_SOURCE 200809L

#include "common.h"
#include <fcntl.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

#define MAX_MESSAGE 1024

static void usage(const char *name)
{
    fprintf(stderr, "Usage: %s --device PATH --text TEXT [--baud RATE] [--timeout-ms MS]\n"
            "8N1 raw, no flow control. Rates: 9600 19200 38400 57600 115200 230400.\n"
            "Default: 115200 baud, 2000 ms total timeout. Max message: 1024 bytes.\n", name);
}

static int baud_code(long baud, speed_t *code)
{
    switch (baud) {
    case 9600: *code = B9600; break;
    case 19200: *code = B19200; break;
    case 38400: *code = B38400; break;
    case 57600: *code = B57600; break;
    case 115200: *code = B115200; break;
    case 230400: *code = B230400; break;
    default: return -1;
    }
    return 0;
}

int main(int argc, char **argv)
{
    const char *device = NULL, *message = NULL;
    long baud = 115200, timeout = 2000;
    for (int i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "--help")) { usage(argv[0]); return 0; }
        if (i + 1 >= argc) { usage(argv[0]); return 2; }
        const char *option = argv[i++];
        if (!strcmp(option, "--device")) device = argv[i];
        else if (!strcmp(option, "--text")) message = argv[i];
        else if (!strcmp(option, "--baud")) {
            if (parse_number(argv[i], 1, 2000000, &baud) < 0) { usage(argv[0]); return 2; }
        } else if (!strcmp(option, "--timeout-ms")) {
            if (parse_number(argv[i], 1, 60000, &timeout) < 0) { usage(argv[0]); return 2; }
        } else { usage(argv[0]); return 2; }
    }
    speed_t speed;
    if (!device || !message || !*message || strlen(message) > MAX_MESSAGE ||
        baud_code(baud, &speed) < 0) {
        usage(argv[0]); return 2;
    }
    if (install_signals() < 0) { perror("sigaction"); return 1; }

    /* 不占用控制终端；非阻塞 I/O 的最长等待由 poll 明确限制。 */
    int fd = open(device, O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) { perror("open serial"); return 1; }
    int result = 1, configured = 0;
    struct termios original, settings;
    if (tcgetattr(fd, &original) < 0) { perror("tcgetattr"); goto done; }
    settings = original;
    cfmakeraw(&settings);
    settings.c_cflag &= ~(CSIZE | PARENB | CSTOPB | CRTSCTS);
    settings.c_cflag |= CS8 | CLOCAL | CREAD;
    settings.c_cc[VMIN] = 0;
    settings.c_cc[VTIME] = 0;
    if (cfsetispeed(&settings, speed) < 0 || cfsetospeed(&settings, speed) < 0 ||
        tcsetattr(fd, TCSANOW, &settings) < 0) {
        perror("configure serial"); goto done;
    }
    configured = 1;
    /* 丢弃旧的接收数据，防止把此前流量错认成本次 echo。 */
    if (tcflush(fd, TCIFLUSH) < 0) { perror("tcflush"); goto done; }
    int64_t start = milliseconds();
    if (start < 0) { perror("clock_gettime"); goto done; }
    int64_t deadline = start + timeout;
    size_t length = strlen(message), sent = 0, received = 0;
    unsigned char reply[MAX_MESSAGE];
    while (sent < length) {
        int ready = wait_ready(fd, POLLOUT, deadline);
        if (ready <= 0) {
            if (!ready) { fprintf(stderr, "Timed out while submitting serial bytes.\n"); result = 3; }
            else perror("serial write wait");
            goto done;
        }
        ssize_t count = write(fd, message + sent, length - sent);
        if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) continue;
        if (count <= 0) { perror("serial write"); goto done; }
        sent += (size_t)count;
    }
    print_bytes("Queued TX", (const unsigned char *)message, sent);
    fflush(stdout);
    /* UART 没有消息边界；这个应用协议约定对端原样回同样数量的字节。 */
    while (received < length) {
        int ready = wait_ready(fd, POLLIN, deadline);
        if (ready <= 0) {
            if (!ready) { fprintf(stderr, "Timed out waiting for application echo (%zu/%zu bytes).\n", received, length); result = 3; }
            else perror("serial read wait");
            goto done;
        }
        ssize_t count = read(fd, reply + received, length - received);
        if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) continue;
        if (count < 0) { perror("serial read"); goto done; }
        if (!count) continue;
        received += (size_t)count;
    }
    print_bytes("Application RX", reply, received);
    if (memcmp(reply, message, length)) {
        fprintf(stderr, "Reply bytes differ from the request.\n"); result = 4;
    } else {
        puts("Echo matches. This is an application reply, not a UART ACK."); result = 0;
    }

done:
    /* TCSANOW 避免把退出路径变成无期限的 tcdrain 等待。 */
    if (configured && tcsetattr(fd, TCSANOW, &original) < 0) {
        perror("restore serial settings");
        if (!result) result = 1;
    }
    close(fd);
    return interrupted ? 130 : result;
}
