//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// configureDetached puts the daemon in a new session so closing the terminal
// does not send it SIGHUP.
func configureDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
