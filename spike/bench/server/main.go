// Stub daemon: answers every newline-framed request with an allow decision.
package main

import (
	"bufio"
	"encoding/json"
	"log"
	"net"
	"os"
)

func main() {
	path := os.Args[1]
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		log.Fatal(err)
	}
	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Fatal(err)
		}
		go func(c net.Conn) {
			defer c.Close()
			line, err := bufio.NewReader(c).ReadBytes('\n')
			if err != nil {
				return
			}
			var req struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(line, &req)
			resp, _ := json.Marshal(map[string]any{"v": 1, "id": req.ID, "response": map[string]string{"decision": "allow"}})
			_, _ = c.Write(append(resp, '\n'))
		}(conn)
	}
}
