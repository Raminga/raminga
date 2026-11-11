package report

import (
	"bytes"
	"fmt"
	"os"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func newCompiler() *jsonschema.Compiler {
	return jsonschema.NewCompiler()
}

func unmarshalJSON(b []byte) (any, error) {
	v, err := jsonschema.UnmarshalJSON(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	return v, nil
}

func readFile(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read schema %q: %w", path, err)
	}
	return b, nil
}
