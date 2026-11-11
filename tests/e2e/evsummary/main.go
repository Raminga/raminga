// Command evsummary converts legacy raw e2e evidence to the compact committed
// summary format. Raw input is copied under .local/evidence/<phase>/.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/Raminga/raminga/tests/e2e/internal/evidence"
)

func main() {
	var (
		in      = flag.String("in", "", "raw evidence JSON")
		phase   = flag.String("phase", "", "phase (g1,g2,g3,g4,g45)")
		base    = flag.String("base", "", "summary basename (default phase)")
		outDir  = flag.String("out", "", "tracked evidence directory")
		root    = flag.String("root", ".", "repository root")
		pointer = flag.Bool("pointer", true, "write LATEST pointer")
	)
	flag.Parse()
	if *in == "" || *phase == "" || *outDir == "" {
		fmt.Fprintln(os.Stderr, "usage: evsummary -in raw.json -phase g2 -out tests/e2e/evidence/g2 [-base g2]")
		os.Exit(2)
	}
	raw, err := os.ReadFile(*in)
	if err != nil {
		panic(err)
	}
	if err := evidence.CheckText(*in); err != nil {
		panic(err)
	}
	s, err := evidence.Summarize(raw, *phase)
	if err != nil {
		panic(err)
	}
	if *base != "" {
		s.Phase = *phase
	}
	if _, err := evidence.WriteRaw(*root, *phase, raw); err != nil {
		panic(err)
	}
	path, err := evidence.Write(*outDir, first(*base, *phase), s)
	if err != nil {
		panic(err)
	}
	if *pointer {
		if err := evidence.WritePointer(*outDir, filepath.Base(path)); err != nil {
			panic(err)
		}
	}
	fmt.Println(path)
}

func first(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
