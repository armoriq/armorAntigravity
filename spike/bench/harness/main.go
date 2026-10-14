// Spawns hook commands the way Antigravity does (sh -c, payload on stdin) and
// reports wall-clock percentiles per spawn. Variants are interleaved per
// iteration so background load affects them equally.
//
// Usage: harness <payload.json> <calls> <label>=<command> [<label>=<command>...]
package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

type variant struct {
	label, command string
	samples        []float64
}

func main() {
	payload, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	n, _ := strconv.Atoi(os.Args[2])
	var variants []*variant
	for _, arg := range os.Args[3:] {
		label, command, _ := strings.Cut(arg, "=")
		variants = append(variants, &variant{label: label, command: command})
	}
	for i := 0; i < 10; i++ {
		for _, v := range variants {
			run(v.command, payload)
		}
	}
	for i := 0; i < n; i++ {
		for _, v := range variants {
			start := time.Now()
			out := run(v.command, payload)
			v.samples = append(v.samples, float64(time.Since(start).Microseconds())/1000)
			if !bytes.Contains(out, []byte(`"allow"`)) {
				panic(fmt.Sprintf("%s: bad output on call %d: %q", v.label, i, out))
			}
		}
	}
	for _, v := range variants {
		s := v.samples
		sort.Float64s(s)
		pct := func(p float64) float64 { return s[int(p*float64(len(s)-1))] }
		fmt.Printf("%-12s n=%d p50=%.2fms p95=%.2fms p99=%.2fms max=%.2fms\n", v.label, n, pct(0.50), pct(0.95), pct(0.99), s[len(s)-1])
	}
}

func run(command string, payload []byte) []byte {
	cmd := exec.Command("sh", "-c", command)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.Output()
	if err != nil {
		panic(err)
	}
	return out
}
