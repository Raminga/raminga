//go:build windows

package api_test

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/api/endpoint"
)

func addEveryoneReadACE(t *testing.T, path string) {
	t.Helper()
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		t.Fatal(err)
	}
	everyone, err := windows.StringToSid("S-1-1-0")
	if err != nil {
		t.Fatal(err)
	}
	var pinner runtime.Pinner
	pinner.Pin(everyone)
	defer pinner.Unpin()
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.GENERIC_READ,
		AccessMode:        windows.GRANT_ACCESS,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_WELL_KNOWN_GROUP,
			TrusteeValue: windows.TrusteeValueFromSID(everyone),
		},
	}}, dacl)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, acl, nil,
	); err != nil {
		t.Fatal(err)
	}
}

// The daemon is live in these tests. A client that ignored a widened ACL would
// reach it and answer Status; rejecting before that is the required behavior.
func TestWindowsCachedClientRejectsWidenedEndpointACL(t *testing.T) {
	ts := startTCPTestServer(t)
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatalf("initial client.New: %v", err)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := c.Status(ctx); err != nil {
		t.Fatalf("initial Status: %v", err)
	}

	addEveryoneReadACE(t, endpoint.Path(ts.dir))

	if _, err := c.Status(ctx); err == nil || !strings.Contains(err.Error(), "ACL") {
		t.Fatalf("cached client after ACL widening = %v, want ACL rejection", err)
	}
	if _, err := client.New(ts.dir); err == nil || !strings.Contains(err.Error(), "ACL") {
		t.Fatalf("new client after ACL widening = %v, want ACL rejection", err)
	}
}
