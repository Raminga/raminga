//go:build windows

package endpoint_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/Raminga/raminga/internal/api/endpoint"
)

func currentSID(t *testing.T) *windows.SID {
	t.Helper()
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = token.Close() }()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	return user.User.Sid
}

// addEveryoneRead merges one extra allow-read ACE into the protected DACL,
// mirroring an administrator or another account widening the file ACL.
func addEveryoneRead(t *testing.T, path string) {
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
	entries := []windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.GENERIC_READ,
		AccessMode:        windows.GRANT_ACCESS,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_WELL_KNOWN_GROUP,
			TrusteeValue: windows.TrusteeValueFromSID(everyone),
		},
	}}
	acl, err := windows.ACLFromEntries(entries, dacl)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		acl,
		nil,
	); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsWriteCreatesProtectedOwnerOnlyDACL(t *testing.T) {
	dir := t.TempDir()
	if err := endpoint.WriteAtomic(dir, testDocument()); err != nil {
		t.Fatalf("WriteAtomic: %v", err)
	}
	path := endpoint.Path(dir)
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	owner, _, err := descriptor.Owner()
	if err != nil {
		t.Fatal(err)
	}
	if !windows.EqualSid(owner, currentSID(t)) {
		t.Fatal("discovery file owner is not the current user")
	}
	control, _, err := descriptor.Control()
	if err != nil {
		t.Fatal(err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatal("discovery file DACL is not protected")
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if dacl == nil {
		t.Fatal("discovery file has no DACL")
	}
	if dacl.AceCount != 1 {
		t.Fatalf("discovery file DACL has %d entries, want 1", dacl.AceCount)
	}
	if _, found, err := endpoint.ReadIfPresent(dir); err != nil || !found {
		t.Fatalf("protected discovery file found=%v err=%v", found, err)
	}
}

func TestWindowsRejectsAdditionalReadACE(t *testing.T) {
	dir := t.TempDir()
	if err := endpoint.WriteAtomic(dir, testDocument()); err != nil {
		t.Fatal(err)
	}
	addEveryoneRead(t, endpoint.Path(dir))
	_, found, err := endpoint.ReadIfPresent(dir)
	if err == nil || found {
		t.Fatalf("widened ACL accepted found=%v err=%v", found, err)
	}
	if !strings.Contains(err.Error(), "ACL") {
		t.Fatalf("ACL rejection is not diagnostic: %v", err)
	}
}

func TestWindowsRejectsReparseDataDirectory(t *testing.T) {
	target := t.TempDir()
	if err := endpoint.WriteAtomic(target, testDocument()); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "junction")
	cmd := exec.Command("cmd", "/c", "mklink", "/J", link, target)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create junction: %v\n%s", err, out)
	}
	t.Cleanup(func() { _ = os.Remove(link) })
	_, found, err := endpoint.ReadIfPresent(link)
	if err == nil || found {
		t.Fatalf("reparse data directory accepted found=%v err=%v", found, err)
	}
	if !strings.Contains(err.Error(), "reparse point") {
		t.Fatalf("reparse rejection is not diagnostic: %v", err)
	}
}

func TestWindowsRejectsNonRegularEndpoint(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(endpoint.Path(dir), 0o700); err != nil {
		t.Fatal(err)
	}
	_, found, err := endpoint.ReadIfPresent(dir)
	if err == nil || found {
		t.Fatalf("directory endpoint accepted found=%v err=%v", found, err)
	}
	if !strings.Contains(err.Error(), "directory") {
		t.Fatalf("directory rejection is not diagnostic: %v", err)
	}
}
