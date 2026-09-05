package source

import (
	"bufio"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
)

// sniffLen is how much of a file is examined to decide its encoding. Big
// enough to reach the accented names that appear well past the header.
const sniffLen = 64 << 10

// eachCSVRow streams a CSV, calling fn with a column accessor. It fails
// fast if any required column is missing from the header.
//
// Two quirks of national dataset exports are handled here rather than in
// each adapter: a UTF-8 BOM glued to the first header cell, and files
// published as Windows-1252 rather than UTF-8 (CNF, and some CoFID CSV
// releases). Both corrupt data silently — the BOM by renaming a column so
// a lookup returns "", the encoding by pushing invalid bytes into
// search_text — so neither can be left to chance.
func eachCSVRow(path string, required []string, fn func(get func(string) string) error) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	defer f.Close()

	br := bufio.NewReaderSize(f, sniffLen)
	var src io.Reader = br
	head, _ := br.Peek(sniffLen) // Peek does not consume; a short read is fine
	if !utf8.Valid(trimPartialRune(head)) {
		src = charmap.Windows1252.NewDecoder().Reader(br)
	}

	r := csv.NewReader(src)
	r.FieldsPerRecord = -1
	r.ReuseRecord = true
	r.LazyQuotes = true

	header, err := r.Read()
	if err != nil {
		return fmt.Errorf("read header of %s: %w", filepath.Base(path), err)
	}
	col := map[string]int{}
	for i, h := range header {
		h = strings.TrimPrefix(h, "\ufeff")
		col[strings.Trim(strings.TrimSpace(h), "\"")] = i
	}
	for _, name := range required {
		if _, ok := col[name]; !ok {
			return fmt.Errorf("%s: missing required column %q", filepath.Base(path), name)
		}
	}

	for {
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read %s: %w", filepath.Base(path), err)
		}
		get := func(name string) string {
			i, ok := col[name]
			if !ok || i >= len(rec) {
				return ""
			}
			return rec[i]
		}
		if err := fn(get); err != nil {
			return err
		}
	}
}

// trimPartialRune drops a multi-byte rune left half-read at the end of the
// sniff window, which would otherwise look like invalid UTF-8 and send a
// perfectly good UTF-8 file down the Windows-1252 path.
func trimPartialRune(b []byte) []byte {
	for i := 0; i < 4 && len(b) > 0; i++ {
		if r, size := utf8.DecodeLastRune(b); r != utf8.RuneError || size > 1 {
			break
		}
		b = b[:len(b)-1]
	}
	return b
}
