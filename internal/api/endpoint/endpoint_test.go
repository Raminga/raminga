package endpoint_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Raminga/raminga/internal/api/endpoint"
)

// Fixed self-signed certificate for 127.0.0.1, valid until 2045. These tests
// only exercise discovery-file protection and document validation; the TLS
// listener tests live in internal/api.
const testCertificatePEM = `-----BEGIN CERTIFICATE-----
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

const testCertificateSHA256 = "281dcc9f6ae6382a6921a5bbbdcb8658e806af4b314aa8117bd7a08fedcb0e00"

func testDocument() endpoint.Document {
	return endpoint.Document{
		Version:         endpoint.Version,
		Network:         endpoint.NetworkTCP,
		Address:         "127.0.0.1:43123",
		Token:           strings.Repeat("a", 64),
		CertPEM:         testCertificatePEM,
		CertSHA256:      testCertificateSHA256,
		PID:             os.Getpid(),
		StartedAtUnixMS: 1,
	}
}

func TestWriteAtomicReadIfPresentAndRemove(t *testing.T) {
	dir := t.TempDir()
	doc := testDocument()
	if err := endpoint.WriteAtomic(dir, doc); err != nil {
		t.Fatalf("WriteAtomic: %v", err)
	}
	got, found, err := endpoint.ReadIfPresent(dir)
	if err != nil || !found {
		t.Fatalf("ReadIfPresent found=%v err=%v", found, err)
	}
	if got.Token != doc.Token || got.CertSHA256 != doc.CertSHA256 || got.Address != doc.Address {
		t.Fatalf("read document = %+v, want %+v", got, doc)
	}
	// A second write must atomically replace the existing discovery file.
	doc.Token = strings.Repeat("b", 64)
	if err := endpoint.WriteAtomic(dir, doc); err != nil {
		t.Fatalf("second WriteAtomic: %v", err)
	}
	got, found, err = endpoint.ReadIfPresent(dir)
	if err != nil || !found || got.Token != doc.Token {
		t.Fatalf("replaced document found=%v token-rotated=%t err=%v", found, got.Token == doc.Token, err)
	}
	leftovers, err := filepath.Glob(filepath.Join(dir, ".api.endpoint-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("temporary discovery files left behind: %v", leftovers)
	}
	if err := endpoint.Remove(dir); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, found, err := endpoint.ReadIfPresent(dir); err != nil || found {
		t.Fatalf("ReadIfPresent after Remove found=%v err=%v", found, err)
	}
}

func TestReadIfPresentMissingDirectoryIsNotAnError(t *testing.T) {
	_, found, err := endpoint.ReadIfPresent(filepath.Join(t.TempDir(), "absent"))
	if err != nil || found {
		t.Fatalf("missing data directory found=%v err=%v", found, err)
	}
}
