package node_test

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Raminga/raminga/internal/p2phttp"
	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
)

// TestFetchManifestRejectsUntrustedResponses runs the client against a peer
// that serves crafted manifests. The client must enforce its own version,
// peer-ID, size, entry-count and path checks; the server is not trusted.
func TestFetchManifestRejectsUntrustedResponses(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())

	key, _, err := crypto.GenerateEd25519Key(nil)
	if err != nil {
		t.Fatal(err)
	}
	fake, err := libp2p.New(libp2p.Identity(key), libp2p.ListenAddrStrings("/ip4/127.0.0.1/tcp/0"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fake.Close() })

	var mu sync.Mutex
	var body string
	setBody := func(next string) {
		mu.Lock()
		body = next
		mu.Unlock()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /manifest", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		current := body
		mu.Unlock()
		_, _ = io.WriteString(w, current)
	})
	srv, err := p2phttp.NewServer(fake, mux, p2phttp.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close(context.Background()) })

	addr := fake.Addrs()[0].String() + "/p2p/" + fake.ID().String()
	if _, err := a.node.Connect(ctx, "", addr); err != nil {
		t.Fatal(err)
	}
	valid := func(fields string) string {
		return fmt.Sprintf(`{"version":1,"peer_id":%q,"generated_at_unix_ms":0,"entries":[],"total":0%s}`, fake.ID().String(), fields)
	}
	setBody(valid(""))
	if _, err := a.node.FetchManifest(ctx, fake.ID().String(), 0, 100); err != nil {
		t.Fatalf("baseline manifest rejected: %v", err)
	}

	var tooMany strings.Builder
	tooMany.WriteString(`{"version":1,"peer_id":` + fmt.Sprintf("%q", fake.ID().String()) + `,"generated_at_unix_ms":0,"entries":[`)
	for i := 0; i < 201; i++ {
		if i > 0 {
			tooMany.WriteByte(',')
		}
		fmt.Fprintf(&tooMany, `{"path":"profile/f%d.txt","size":1,"modified_unix_ms":0,"sha256":"abc"}`, i)
	}
	tooMany.WriteString(`],"total":201}`)

	cases := []struct {
		name string
		body string
		want string
	}{
		{"oversized", strings.Repeat(" ", 64<<10+1), "limit"},
		{"malformed", `{"version":1,`, "invalid manifest"},
		{"unknown field", valid(`,"extra":1`), "invalid manifest"},
		{"trailing data", valid("") + `{}`, "trailing data"},
		{"wrong version", `{"version":2,"peer_id":"` + fake.ID().String() + `","entries":[],"total":0}`, "unsupported manifest version"},
		{"wrong peer id", fmt.Sprintf(`{"version":1,"peer_id":%q,"entries":[],"total":0}`, a.status(t).PeerID), "does not match"},
		{"too many entries", tooMany.String(), "exceeds server caps"},
		{"unsafe path", fmt.Sprintf(`{"version":1,"peer_id":%q,"entries":[{"path":"../x","size":1,"sha256":"abc"}],"total":1}`, fake.ID().String()), "invalid manifest entry"},
		{"missing hash", fmt.Sprintf(`{"version":1,"peer_id":%q,"entries":[{"path":"profile/x","size":1,"sha256":""}],"total":1}`, fake.ID().String()), "invalid manifest entry"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// The node uses the first-version 5/s, burst-10 per-peer limiter.
			time.Sleep(250 * time.Millisecond)
			setBody(tc.body)
			_, err := a.node.FetchManifest(ctx, fake.ID().String(), 0, 100)
			if err == nil {
				t.Fatal("malicious manifest accepted")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err, tc.want)
			}
		})
	}
}
