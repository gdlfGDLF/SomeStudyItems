#ifndef STUDY_COMMON_H
#define STUDY_COMMON_H

#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

/* 小工具：所有等待都使用同一个单调时钟截止时间，避免重试不断延长超时。 */
static volatile sig_atomic_t interrupted;

static inline void on_signal(int number)
{
    (void)number;
    interrupted = 1;
}

static inline int install_signals(void)
{
    struct sigaction action = {0};
    action.sa_handler = on_signal;
    sigemptyset(&action.sa_mask);
    return sigaction(SIGINT, &action, NULL) < 0 ||
           sigaction(SIGTERM, &action, NULL) < 0 ? -1 : 0;
}

static inline int parse_number(const char *text, long low, long high, long *value)
{
    char *end;
    errno = 0;
    long result = strtol(text, &end, 10);
    if (errno || end == text || *end || result < low || result > high) return -1;
    *value = result;
    return 0;
}

static inline int64_t milliseconds(void)
{
    struct timespec time;
    if (clock_gettime(CLOCK_MONOTONIC, &time) < 0) return -1;
    return (int64_t)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}

/* 返回 1：可尝试 I/O；0：超时；-1：错误或用户中止。 */
static inline int wait_ready(int fd, short events, int64_t deadline)
{
    while (!interrupted) {
        int64_t now = milliseconds();
        if (now < 0) return -1;
        int64_t left = deadline - now;
        if (left <= 0) return 0;
        struct pollfd item = {.fd = fd, .events = events, .revents = 0};
        int result = poll(&item, 1, left > INT_MAX ? INT_MAX : (int)left);
        if (result < 0 && errno == EINTR) continue;
        if (result < 0) return -1;
        if (!result) return 0;
        if (item.revents & events) return 1;
        if (item.revents & (POLLERR | POLLHUP | POLLNVAL)) {
            errno = EIO;
            return -1;
        }
    }
    errno = EINTR;
    return -1;
}

static inline void print_bytes(const char *label, const unsigned char *data, size_t size)
{
    printf("%s %zu bytes:", label, size);
    for (size_t i = 0; i < size; ++i) printf(" %02X", (unsigned int)data[i]);
    putchar('\n');
}

#endif
