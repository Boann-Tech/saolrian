package main

import (
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// forbiddenServerDeps are the ingest packages that must never be linked
// into the server binary.
//
// internal/foodpack/format is the one foodpack package the server may
// import: it is the pack decoder and nothing more. The adapters in
// internal/foodpack/source pull in dataset parsers (and, later, xlsx and
// XML readers) that have no business in a server, and cmd/foodpack is a
// separate program entirely.
//
// The temptation is concrete rather than hypothetical: the search
// aggregator needs the same query normalisation the pack was built with,
// which is exactly why food.SearchText lives in internal/food. A doc
// comment alone would not stop the next person reaching for
// source.SearchText, and this repo has no CI to catch it either.
var forbiddenServerDeps = []string{
	"github.com/boanntech/saolrian/backend/internal/foodpack/source",
	"github.com/boanntech/saolrian/backend/cmd/foodpack",
}

// TestServerBinaryDoesNotLinkIngestPackages asks the toolchain for the
// server main package's full transitive import set and asserts none of the
// ingest packages appear in it.
func TestServerBinaryDoesNotLinkIngestPackages(t *testing.T) {
	goBin := goToolPath(t)

	out, err := exec.Command(goBin, "list", "-deps", "-f", "{{.ImportPath}}",
		"github.com/boanntech/saolrian/backend").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps: %v\n%s", err, out)
	}

	deps := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			deps[line] = true
		}
	}
	if len(deps) == 0 {
		t.Fatal("go list -deps returned no packages; the check would be vacuous")
	}
	// Sanity anchor: if this is absent, go list did not resolve the server
	// package and the negative assertions below prove nothing.
	if !deps["github.com/boanntech/saolrian/backend/internal/routes"] {
		t.Fatalf("go list -deps did not report the server's own packages (%d deps listed)", len(deps))
	}

	for _, pkg := range forbiddenServerDeps {
		if deps[pkg] {
			t.Errorf("server binary transitively imports %s; only internal/foodpack/format may cross that line", pkg)
		}
	}
}

// goToolPath locates the go command that is running this test, falling back
// to PATH.
func goToolPath(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("go", "env", "GOROOT").Output()
	if err == nil {
		if root := strings.TrimSpace(string(out)); root != "" {
			bin := filepath.Join(root, "bin", "go")
			if runtime.GOOS == "windows" {
				bin += ".exe"
			}
			return bin
		}
	}
	bin, err := exec.LookPath("go")
	if err != nil {
		t.Fatalf("cannot locate the go tool: %v", err)
	}
	return bin
}
