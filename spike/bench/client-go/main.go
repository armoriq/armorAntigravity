// Prototype agd-hook: stdin payload to the daemon over a unix socket, response to stdout.
package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"os"
	"strconv"
	"time"
)

func main() {
	event := os.Args[1]
	stdin, err := io.ReadAll(os.Stdin)
	if err != nil {
		os.Exit(1)
	}
	conn, err := net.DialTimeout("unix", os.Getenv("ARMORANTIGRAVITY_SOCKET"), 2*time.Second)
	if err != nil {
		os.Exit(1)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	req, _ := json.Marshal(map[string]any{
		"v": 1, "id": strconv.Itoa(os.Getpid()), "receivedAt": time.Now().UnixMilli(),
		"event": event, "payload": json.RawMessage(stdin),
	})
	if _, err := conn.Write(append(req, '\n')); err != nil {
		os.Exit(1)
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		os.Exit(1)
	}
	var resp struct {
		Response json.RawMessage `json:"response"`
	}
	if json.Unmarshal(line, &resp) != nil {
		os.Exit(1)
	}
	_, _ = os.Stdout.Write(resp.Response)
}
