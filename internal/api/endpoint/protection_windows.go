//go:build windows

package endpoint

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows uses a protected DACL containing only the current process token's
// user SID. The ACL is applied when the temporary discovery file is created,
// verified through the same handle, and the token is not written until that
// verification succeeds. Publishing uses a rename relative to one opened data
// directory handle, so a replaced path or reparse point cannot redirect the
// final name.
const (
	fileShareAll = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE
)

func platformSupported() error { return nil }

func currentUserSID() (*windows.SID, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		return nil, fmt.Errorf("local API endpoint: open current process token: %w", err)
	}
	defer func() { _ = token.Close() }()
	user, err := token.GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("local API endpoint: read current user SID: %w", err)
	}
	if user.User.Sid == nil {
		return nil, errors.New("local API endpoint: current process has no user SID")
	}
	return user.User.Sid, nil
}

// longPath adds the extended-length prefix for paths that Windows would
// otherwise truncate. Everything passed here is already absolute.
func longPath(path string) string {
	if strings.HasPrefix(path, `\\?\`) {
		return path
	}
	if len(path) < 248 {
		return path
	}
	if strings.HasPrefix(path, `\\`) {
		return `\\?\UNC\` + strings.TrimPrefix(path, `\\`)
	}
	return `\\?\` + path
}

// openDataDirectory opens the directory itself without following a final
// reparse point. Subsequent file operations use this handle as their root, so
// replacing the directory pathname afterwards cannot redirect them.
func openDataDirectory(dataDir string, access uint32) (windows.Handle, error) {
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return 0, fmt.Errorf("local API endpoint: resolve data directory %q: %w", dataDir, err)
	}
	ptr, err := windows.UTF16PtrFromString(longPath(abs))
	if err != nil {
		return 0, fmt.Errorf("local API endpoint: encode data directory: %w", err)
	}
	h, err := windows.CreateFile(
		ptr,
		access,
		fileShareAll,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return 0, os.ErrNotExist
		}
		return 0, fmt.Errorf("local API endpoint: open data directory %q: %w", dataDir, err)
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		_ = windows.CloseHandle(h)
		return 0, fmt.Errorf("local API endpoint: inspect data directory %q: %w", dataDir, err)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		_ = windows.CloseHandle(h)
		return 0, fmt.Errorf("local API endpoint: data directory %q is not a directory", dataDir)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		_ = windows.CloseHandle(h)
		return 0, fmt.Errorf("local API endpoint: data directory %q is a reparse point; refusing an ambiguous discovery path", dataDir)
	}
	return h, nil
}

func ntStatusIsNotFound(err error) bool {
	var status windows.NTStatus
	if !errors.As(err, &status) {
		return false
	}
	return status == windows.STATUS_OBJECT_NAME_NOT_FOUND || status == windows.STATUS_OBJECT_PATH_NOT_FOUND
}

// openRelative opens a child of an already-opened directory handle. The
// relative name cannot walk out of the directory or traverse a nested path.
func openRelative(dir windows.Handle, name string, access, disposition, options uint32, security *windows.SECURITY_DESCRIPTOR) (windows.Handle, error) {
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return 0, err
	}
	oa := &windows.OBJECT_ATTRIBUTES{
		ObjectName:         objectName,
		Attributes:         windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE,
		RootDirectory:      dir,
		SecurityDescriptor: security,
	}
	oa.Length = uint32(unsafe.Sizeof(*oa))
	var iosb windows.IO_STATUS_BLOCK
	var allocation int64
	var handle windows.Handle
	err = windows.NtCreateFile(
		&handle,
		access,
		oa,
		&iosb,
		&allocation,
		0,
		fileShareAll,
		disposition,
		options,
		0,
		0,
	)
	if err != nil {
		return 0, err
	}
	return handle, nil
}

func readProtectedFile(path string) ([]byte, bool, error) {
	dir, err := openDataDirectory(filepath.Dir(path), windows.FILE_GENERIC_READ|windows.FILE_TRAVERSE)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, err
	}
	defer func() { _ = windows.CloseHandle(dir) }()

	handle, err := openRelative(
		dir,
		filepath.Base(path),
		windows.FILE_GENERIC_READ|windows.READ_CONTROL,
		windows.FILE_OPEN,
		windows.FILE_NON_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT,
		nil,
	)
	if err != nil {
		if ntStatusIsNotFound(err) {
			return nil, false, nil
		}
		if status, ok := err.(windows.NTStatus); ok {
			switch status {
			case windows.STATUS_REPARSE_POINT_ENCOUNTERED:
				return nil, false, fmt.Errorf("local API endpoint: %q is a reparse point", path)
			case windows.STATUS_FILE_IS_A_DIRECTORY:
				return nil, false, fmt.Errorf("local API endpoint: %q is a directory", path)
			}
		}
		return nil, false, fmt.Errorf("local API endpoint: open %q: %w", path, err)
	}
	f := os.NewFile(uintptr(handle), path)
	defer func() { _ = f.Close() }()

	if err := verifyProtectedHandle(handle, path); err != nil {
		return nil, false, err
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxFileSize+1))
	if err != nil {
		return nil, false, fmt.Errorf("local API endpoint: read %q: %w", path, err)
	}
	if len(raw) > maxFileSize {
		return nil, false, fmt.Errorf("local API endpoint: %q is too large", path)
	}
	return raw, true, nil
}

func verifyProtectedHandle(handle windows.Handle, path string) error {
	if fileType, err := windows.GetFileType(handle); err != nil || fileType != windows.FILE_TYPE_DISK {
		return fmt.Errorf("local API endpoint: %q is not a regular disk file", path)
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return fmt.Errorf("local API endpoint: inspect %q: %w", path, err)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		return fmt.Errorf("local API endpoint: %q is a directory", path)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("local API endpoint: %q is a reparse point", path)
	}
	size := int64(info.FileSizeHigh)<<32 | int64(info.FileSizeLow)
	if size > maxFileSize {
		return fmt.Errorf("local API endpoint: %q is too large", path)
	}

	sid, err := currentUserSID()
	if err != nil {
		return err
	}
	descriptor, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("local API endpoint: read Windows ACL for %q: %w", path, err)
	}
	owner, _, err := descriptor.Owner()
	if err != nil {
		return fmt.Errorf("local API endpoint: read owner of %q: %w", path, err)
	}
	if owner == nil || !windows.EqualSid(owner, sid) {
		return fmt.Errorf("local API endpoint: Windows owner of %q does not match the current user", path)
	}
	control, _, err := descriptor.Control()
	if err != nil {
		return fmt.Errorf("local API endpoint: read Windows ACL control for %q: %w", path, err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		return fmt.Errorf("local API endpoint: Windows ACL for %q is not a protected DACL", path)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return fmt.Errorf("local API endpoint: read Windows DACL for %q: %w", path, err)
	}
	if dacl == nil || dacl.AceCount != 1 {
		return fmt.Errorf("local API endpoint: Windows ACL for %q must contain exactly one owner-only entry", path)
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(dacl, 0, &ace); err != nil {
		return fmt.Errorf("local API endpoint: read Windows ACL entry for %q: %w", path, err)
	}
	if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
		return fmt.Errorf("local API endpoint: Windows ACL for %q contains an unexpected access control entry", path)
	}
	if ace.Header.AceFlags&windows.INHERITED_ACE != 0 || ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
		return fmt.Errorf("local API endpoint: Windows ACL for %q contains an inherited or inherit-only entry", path)
	}
	aceSID := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
	if !windows.EqualSid(aceSID, sid) {
		return fmt.Errorf("local API endpoint: Windows ACL for %q grants access to a SID other than the current user", path)
	}
	if !grantsRead(ace.Mask) {
		return fmt.Errorf("local API endpoint: Windows ACL for %q does not grant the current user read access", path)
	}
	return nil
}

func grantsRead(mask windows.ACCESS_MASK) bool {
	if mask&windows.GENERIC_ALL != 0 || mask&windows.GENERIC_READ != 0 {
		return true
	}
	return mask&windows.FILE_GENERIC_READ == windows.FILE_GENERIC_READ
}

func protectedSecurityDescriptor(sid *windows.SID) (*windows.SECURITY_DESCRIPTOR, error) {
	// O: pins the owner to the current user and D:P marks the DACL protected,
	// so no parent ACEs are inherited into the token-bearing file. GA is
	// sufficient for the daemon's own read/write and later removal; the
	// verification below requires that exact owner and a one-entry DACL.
	sddl := fmt.Sprintf("O:%sD:P(A;;GA;;;%s)", sid.String(), sid.String())
	descriptor, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return nil, fmt.Errorf("local API endpoint: build Windows security descriptor: %w", err)
	}
	return descriptor, nil
}

func randomTempName() (string, error) {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return ".api.endpoint-" + hex.EncodeToString(raw[:]), nil
}

func markForDelete(handle windows.Handle) {
	var disposition [1]byte
	disposition[0] = 1
	_ = windows.SetFileInformationByHandle(handle, windows.FileDispositionInfo, &disposition[0], uint32(len(disposition)))
}

type fileRenameInformation struct {
	ReplaceIfExists uint32
	RootDirectory   windows.Handle
	FileNameLength  uint32
	FileName        [1]uint16
}

// renameRelative publishes the still-open temporary file without ever naming
// its parent directory again. The same handle validated before the token was
// written becomes the final discovery file.
func renameRelative(dir, file windows.Handle, name string) error {
	wide, err := windows.UTF16FromString(name)
	if err != nil {
		return err
	}
	nameBytes := (len(wide) - 1) * 2
	var layout fileRenameInformation
	size := int(unsafe.Offsetof(layout.FileName)) + nameBytes
	buffer := make([]byte, size)
	info := (*fileRenameInformation)(unsafe.Pointer(&buffer[0]))
	info.ReplaceIfExists = windows.FILE_RENAME_REPLACE_IF_EXISTS
	info.RootDirectory = dir
	info.FileNameLength = uint32(nameBytes)
	copy(unsafe.Slice(&info.FileName[0], nameBytes/2), wide[:len(wide)-1])
	var iosb windows.IO_STATUS_BLOCK
	return windows.NtSetInformationFile(file, &iosb, &buffer[0], uint32(len(buffer)), windows.FileRenameInformation)
}

func writeProtectedFile(path string, raw []byte) error {
	dir, err := openDataDirectory(filepath.Dir(path), windows.FILE_GENERIC_READ|windows.FILE_GENERIC_WRITE|windows.FILE_TRAVERSE)
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(dir) }()

	sid, err := currentUserSID()
	if err != nil {
		return err
	}
	descriptor, err := protectedSecurityDescriptor(sid)
	if err != nil {
		return err
	}
	name := filepath.Base(path)
	var handle windows.Handle
	for attempt := 0; attempt < 16; attempt++ {
		tempName, err := randomTempName()
		if err != nil {
			return fmt.Errorf("local API endpoint: generate temporary name: %w", err)
		}
		handle, err = openRelative(
			dir,
			tempName,
			windows.FILE_GENERIC_READ|windows.FILE_GENERIC_WRITE|windows.DELETE|windows.READ_CONTROL|windows.WRITE_DAC|windows.FILE_WRITE_ATTRIBUTES,
			windows.FILE_CREATE,
			windows.FILE_NON_DIRECTORY_FILE|windows.FILE_SYNCHRONOUS_IO_NONALERT,
			descriptor,
		)
		if err == nil {
			break
		}
		if status, ok := err.(windows.NTStatus); ok && status == windows.STATUS_OBJECT_NAME_COLLISION {
			continue
		}
		return fmt.Errorf("local API endpoint: create protected temporary file: %w", err)
	}
	if handle == 0 {
		return errors.New("local API endpoint: could not allocate a unique temporary file")
	}

	f := os.NewFile(uintptr(handle), path)
	published := false
	defer func() {
		if !published {
			markForDelete(handle)
		}
		_ = f.Close()
	}()

	// Verify the creation-time DACL/owner through this handle before any token
	// byte is written. A caller that cannot verify must not write the secret.
	if err := verifyProtectedHandle(handle, path); err != nil {
		return err
	}
	if _, err := f.Write(raw); err != nil {
		return fmt.Errorf("local API endpoint: write temporary file: %w", err)
	}
	if err := f.Sync(); err != nil {
		return fmt.Errorf("local API endpoint: sync temporary file: %w", err)
	}
	if err := renameRelative(dir, handle, name); err != nil {
		return fmt.Errorf("local API endpoint: publish discovery file: %w", err)
	}
	published = true
	if err := f.Close(); err != nil {
		return fmt.Errorf("local API endpoint: close discovery file: %w", err)
	}
	return nil
}
