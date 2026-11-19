package api_test

import (
	"context"
	"testing"
	"time"

	"github.com/Raminga/raminga/internal/api"
	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/node"
)

func TestStage6ListDiscoveriesAndDownloadEvidenceRPC(t *testing.T) {
	ts := startServer(t, false)
	ts.backend.discoveryPage = node.PublicDiscoveryPage{
		Discoveries: []node.PublicDiscovery{{
			ID: 7, PeerID: "peer-b", Path: "posts/a.json", SHA256: "aabbcc", SizeBytes: 12,
			FetchedAt: time.UnixMilli(1234), Source: "raminga_ui_manual",
			Sources: []string{"raminga_content_get", "raminga_ui_manual"},
		}},
		HasMore: false,
	}
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	status, err := c.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.GetApiVersion() != api.APIVersion || api.APIVersion != "6" {
		t.Fatalf("api_version = %q / const %q", status.GetApiVersion(), api.APIVersion)
	}

	page, err := c.ListDiscoveries(context.Background(), "", 20, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Discoveries) != 1 {
		t.Fatalf("discoveries = %+v", page.Discoveries)
	}
	d := page.Discoveries[0]
	if d.GetId() != "7" || d.GetPeerId() != "peer-b" || d.GetPath() != "posts/a.json" ||
		d.GetSha256() != "aabbcc" || d.GetFetchedAtUnixMs() != 1234 || d.GetSource() != "raminga_ui_manual" {
		t.Fatalf("discovery source lost: %+v", d)
	}
	if len(d.GetSources()) != 2 || d.GetSources()[0] != "raminga_content_get" || d.GetSources()[1] != "raminga_ui_manual" {
		t.Fatalf("discovery = %+v", d)
	}
	if ts.backend.discoveryPostCandidatesOnly {
		t.Fatal("legacy ListDiscoveries must keep the mixed-file contract")
	}
	if _, err := c.ListPostCandidateDiscoveries(context.Background(), "", 20, false, "peer-b"); err != nil {
		t.Fatal(err)
	}
	if !ts.backend.discoveryPostCandidatesOnly {
		t.Fatal("post_candidates_only was not forwarded to the backend")
	}

	stream, err := c.DownloadPeerFileWithEvidence(context.Background(), "peer-b", "a", "raminga_content_get")
	if err != nil {
		t.Fatal(err)
	}
	var final any
	for stream.Receive() {
		final = stream.Msg()
	}
	if err := stream.Err(); err != nil {
		t.Fatal(err)
	}
	if ts.backend.downloadOption.RecordDiscovery != true || ts.backend.downloadOption.DiscoverySource != "raminga_content_get" {
		t.Fatalf("download options = %+v", ts.backend.downloadOption)
	}
	frame, ok := final.(interface {
		GetDiscoveryId() int64
		GetDiscoveryRecorded() bool
	})
	if !ok || frame.GetDiscoveryId() != 7 || !frame.GetDiscoveryRecorded() {
		t.Fatalf("final frame = %#v", final)
	}

	// A manual/legacy download request stays unattributed.
	manual, err := c.DownloadPeerFile(context.Background(), "peer-b", "a")
	if err != nil {
		t.Fatal(err)
	}
	for manual.Receive() {
	}
	if err := manual.Err(); err != nil {
		t.Fatal(err)
	}
	if ts.backend.downloadOption.RecordDiscovery || ts.backend.downloadOption.DiscoverySource != "" {
		t.Fatalf("manual download options = %+v", ts.backend.downloadOption)
	}
}
