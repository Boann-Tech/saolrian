package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/boanntech/saolrian/backend/internal/foodpack/source"
)

// fetchTimeout bounds one archive. The USDA SR Legacy zip is a few hundred
// megabytes over a slow link.
const fetchTimeout = 30 * time.Minute

func fetchCmd(args []string) error {
	fs := flag.NewFlagSet("fetch", flag.ExitOnError)
	work := fs.String("work", "", "work directory to download and extract into")
	only := fs.String("source", "", "comma-separated sources to fetch (default: all)")
	force := fs.Bool("force", false, "re-download even when the archive is already present and matches")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *work == "" {
		return fmt.Errorf("--work is required")
	}

	entries, err := source.LoadManifest()
	if err != nil {
		return err
	}
	want := map[string]bool{}
	for _, s := range strings.Split(*only, ",") {
		if s = strings.TrimSpace(s); s != "" {
			want[s] = true
		}
	}

	client := &http.Client{}

	var failed []string
	for _, e := range entries {
		if len(want) > 0 && !want[e.Source] {
			continue
		}
		fmt.Printf("== %s\n", e.Source)
		ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
		err := fetchOne(ctx, client, e, *work, *force, os.Stdout)
		cancel()
		if err != nil {
			// One dataset moving must not stop the other four. Report at
			// the end so the operator fixes them in one sitting.
			fmt.Fprintf(os.Stderr, "   %v\n", err)
			failed = append(failed, e.Source)
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("%d source(s) failed: %s", len(failed), strings.Join(failed, ", "))
	}
	return nil
}

// fetchOne downloads, hashes and extracts one manifest entry.
func fetchOne(ctx context.Context, client *http.Client, e source.ManifestEntry, work string, force bool, out io.Writer) error {
	dest := filepath.Join(work, e.ExtractTo)
	archiveDir := filepath.Join(work, "_archives")
	if err := os.MkdirAll(archiveDir, 0o755); err != nil {
		return err
	}
	name := path.Base(e.URL)
	if name == "" || name == "." || name == "/" {
		name = e.Source
	}
	archive := filepath.Join(archiveDir, name)

	sum, err := hashFile(archive)
	switch {
	case err == nil && !force && e.SHA256 != source.Unpinned && sum == e.SHA256:
		fmt.Fprintf(out, "   cached %s\n", archive)
	default:
		sum, err = downloadTo(ctx, client, e.URL, archive)
		if err != nil {
			return fmt.Errorf("%s: %w\n   download it by hand and unpack it into %s",
				e.Source, err, dest)
		}
	}

	if e.SHA256 == source.Unpinned {
		fmt.Fprintf(out, "   UNPINNED — paste this into manifest/sources.csv: %s\n", sum)
	} else if sum != e.SHA256 {
		os.Remove(archive)
		return fmt.Errorf("%s: sha256 mismatch: manifest pins %s but %s served %s (upstream file changed; check the release notes before re-pinning)",
			e.Source, e.SHA256, e.URL, sum)
	}

	if err := os.RemoveAll(dest); err != nil {
		return err
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	switch e.ArchiveKind {
	case "zip":
		if err := extractZip(archive, dest); err != nil {
			return fmt.Errorf("%s: %w", e.Source, err)
		}
	default: // xlsx, xml, csv — the download is the file
		if err := copyFile(archive, filepath.Join(dest, name)); err != nil {
			return fmt.Errorf("%s: %w", e.Source, err)
		}
	}

	rec := e
	rec.SHA256 = sum
	if err := source.WriteFetchRecord(dest, rec); err != nil {
		return err
	}
	fmt.Fprintf(out, "   ready %s\n", dest)
	return nil
}

// downloadTo streams url into dst, hashing as it goes, and returns the
// hex SHA-256. It writes through a temp file so a failed download never
// leaves a truncated archive that a later run would treat as cached.
func downloadTo(ctx context.Context, client *http.Client, url, dst string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s: %s", url, resp.Status)
	}

	tmp, err := os.CreateTemp(filepath.Dir(dst), filepath.Base(dst)+".part-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), resp.Body); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func hashFile(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// extractZip unpacks archive into dest, flattening the release-named
// wrapper directory every dataset zip carries. Adapters take a flat
// directory, and the wrapper's name changes with every release.
func extractZip(archive, dest string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()

	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	written := map[string]string{}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		// These archives come off the network. Flattening to the base name
		// already defuses an entry named ../../x, but a traversal attempt
		// means the archive is not what it claims to be, so refuse the
		// whole thing rather than quietly unpacking the rest of it.
		if hasDotDot(f.Name) {
			return fmt.Errorf("zip entry %q escapes the target directory", f.Name)
		}
		base := filepath.Base(filepath.FromSlash(f.Name))
		if base == "." || base == ".." || base == "" {
			return fmt.Errorf("zip entry %q has no usable file name", f.Name)
		}
		if prev, dup := written[base]; dup {
			return fmt.Errorf("zip entries %q and %q both flatten to %q", prev, f.Name, base)
		}
		written[base] = f.Name

		if err := writeZipEntry(f, filepath.Join(dest, base)); err != nil {
			return err
		}
	}
	if len(written) == 0 {
		return fmt.Errorf("%s contains no files", filepath.Base(archive))
	}
	return nil
}

// hasDotDot reports a path traversal element, without tripping over an
// ordinary name like "foo..csv".
func hasDotDot(name string) bool {
	for _, part := range strings.Split(filepath.ToSlash(name), "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

func writeZipEntry(f *zip.File, dst string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	w, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer w.Close()
	if _, err := io.Copy(w, rc); err != nil {
		return err
	}
	return w.Close()
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}
