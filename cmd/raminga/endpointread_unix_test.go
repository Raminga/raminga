//go:build !windows

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Raminga/raminga/internal/api/endpoint"
)

const endpointReadTestCert = `-----BEGIN CERTIFICATE-----
MIIBpzCCAU6gAwIBAgIUZ23QTVJYwFQgFTsEi/AiqjWRbJcwCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWcmFtaW5nYS1sb2NhbC1hcGktdGVzdDAeFw0yMDAxMDEwMDAw
MDBaFw00NTAxMDEwMDAwMDBaMCExHzAdBgNVBAMMFnJhbWluZ2EtbG9jYWwtYXBp
LXRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATblYfAHWpF2gNm3qZcY8LC
XN7RDc6+DYnZT0/E5VTcS+5yuUAgprgEhUAiFu62xhaAHCMD08CaOvflzyjmwq3y
o2QwYjAdBgNVHQ4EFgQUNfMqw4ELFTBoWmMPk21Ud1De/kwwHwYDVR0jBBgwFoAU
NfMqw4ELFTBoWmMPk21Ud1De/kwwDwYDVR0RBAgwBocEfwAAATAPBgNVHRMBAf8E
BTADAQH/MAoGCCqGSM49BAMCA0cAMEQCICo58P2DcyJ/Z6P1hgu7oLUONMjqa4X+
d0zq5AOkP1UgAiByXCShk/LK2YU5GmUiUrgVpbkn8XKeLhdJ9b5T/lMg1g==
-----END CERTIFICATE-----
`

func TestInternalAPIEndpointRefusesNonPipeStdout(t *testing.T) {
	bin := requireCLI(t)
	dir := t.TempDir()
	file, err := os.Create(filepath.Join(dir, "stdout.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	cmd := exec.Command(bin, internalAPIEndpointCommand, "--data-dir", dir)
	cmd.Stdout = file
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err == nil {
		t.Fatal("non-pipe stdout unexpectedly accepted")
	}
	if !strings.Contains(stderr.String(), "non-pipe stdout") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestInternalAPIEndpointReportsMissingWithoutReadingToken(t *testing.T) {
	bin := requireCLI(t)
	out, err := exec.Command(bin, internalAPIEndpointCommand, "--data-dir", t.TempDir()).Output()
	if err != nil {
		t.Fatalf("missing endpoint: %v", err)
	}
	var response struct {
		Found    bool               `json:"found"`
		Document *endpoint.Document `json:"document"`
	}
	if err := json.Unmarshal(out, &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Found || response.Document != nil {
		t.Fatalf("missing endpoint response = %+v", response)
	}
}

func TestInternalAPIEndpointWritesDocumentOnlyToPipe(t *testing.T) {
	bin := requireCLI(t)
	dir := t.TempDir()
	doc := endpoint.Document{
		Version:         endpoint.Version,
		Network:         endpoint.NetworkTCP,
		Address:         "127.0.0.1:43123",
		Token:           strings.Repeat("c", 64),
		CertPEM:         endpointReadTestCert,
		CertSHA256:      "281dcc9f6ae6382a6921a5bbbdcb8658e806af4b314aa8117bd7a08fedcb0e00",
		PID:             os.Getpid(),
		StartedAtUnixMS: 1,
	}
	if err := endpoint.WriteAtomic(dir, doc); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(bin, internalAPIEndpointCommand, "--data-dir", dir).Output()
	if err != nil {
		t.Fatalf("%s: %v", internalAPIEndpointCommand, err)
	}
	var response struct {
		Found    bool               `json:"found"`
		Document *endpoint.Document `json:"document"`
	}
	if err := json.Unmarshal(out, &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !response.Found || response.Document == nil || response.Document.Token != doc.Token {
		t.Fatalf("response found=%v document=%+v", response.Found, response.Document)
	}
}
