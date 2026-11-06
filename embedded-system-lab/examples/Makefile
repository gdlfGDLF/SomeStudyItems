CC ?= cc
CFLAGS ?= -O2 -g
CFLAGS += -std=c11 -Wall -Wextra -Wpedantic -Werror

.PHONY: all clean check
all: serial_echo udp_echo

serial_echo: serial_echo.c common.h
	$(CC) $(CPPFLAGS) $(CFLAGS) serial_echo.c -o $@ $(LDFLAGS) $(LDLIBS)

udp_echo: udp_echo.c common.h
	$(CC) $(CPPFLAGS) $(CFLAGS) udp_echo.c -o $@ $(LDFLAGS) $(LDLIBS)

check: all
	python3 smoke.py

clean:
	rm -f serial_echo udp_echo
