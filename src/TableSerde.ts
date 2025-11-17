import { TableCell, TableContent, TableRow } from "./TableData";

class SeparatorLine {
    columnLengths: number[];
    // Optional visual widths for each column; used only as layout hints,
    // not for parsing. When null, no explicit visual widths are encoded.
    visualWidths: number[] | null;

    constructor(columnIndices: number[], visualWidths: number[] | null = null) {
        if (columnIndices.length < 1) {
            throw new Error("columnIndices must not be empty!");
        }

        this.columnLengths = columnIndices;
        this.visualWidths = visualWidths;
    }

    equals(other: SeparatorLine) {
        return this.columnLengths.toString() === other.columnLengths.toString();
    }

    toString() {
        return `SeparatorLine([${this.columnLengths}])`;
    }

    toStringRepr() {
        const parts: string[] = [];
        const visual = this.visualWidths;

        for (let i = 0; i < this.columnLengths.length; i++) {
            const length = this.columnLengths[i];
            const dashes = "-".repeat(length);
            let suffix = "";

            if (visual && visual[i] != null && !Number.isNaN(visual[i])) {
                suffix = visual[i].toString();
            }

            parts.push(dashes + suffix);
        }

        return `+${parts.join("+")}+`;
    }

    static tryParse(line: string): SeparatorLine {
        // Accept either the legacy form '+--+---+-+' or an extended form
        // '+--10+---20+-+' where numeric suffixes after the dashes encode
        // visual widths.
        if (!line.startsWith("+") || !line.endsWith("+")) {
            throw new Error("Line doesn't match format! Should look like this: '+--+---+-+'!");
        }

        const columnLengths: number[] = [];
        const visualWidths: (number | null)[] = [];

        let i = 1; // start after leading '+'
        while (i < line.length - 1) {
            // Parse one column segment of the form -+ or -<digits>+
            let dashCount = 0;
            while (i < line.length - 1 && line[i] === "-") {
                dashCount++;
                i++;
            }

            if (dashCount === 0) {
                throw new Error("Line doesn't match format! Should look like this: '+--+---+-+'!");
            }

            // Optional numeric suffix for visual width
            let widthDigits = "";
            while (i < line.length - 1 && /[0-9]/.test(line[i])) {
                widthDigits += line[i];
                i++;
            }

            if (line[i] !== "+") {
                throw new Error("Line doesn't match format! Should look like this: '+--+---+-+'!");
            }

            columnLengths.push(dashCount);
            if (widthDigits.length > 0) {
                visualWidths.push(parseInt(widthDigits, 10));
            } else {
                visualWidths.push(null);
            }

            i++; // skip '+'
        }

        if (columnLengths.length === 0) {
            throw new Error("Line doesn't match format! Should look like this: '+--+---+-+'!");
        }

        // If there are no numeric hints at all, keep visualWidths as null
        const hasVisual = visualWidths.some((v) => v !== null);
        const visual = hasVisual ? visualWidths.map((v) => (v == null ? 0 : v)) : null;

        return new SeparatorLine(columnLengths, visual);
    }
}


class ContentLine {
    dataChunks: string[]

    constructor(dataChunks: string[]) {
        this.dataChunks = dataChunks;
    }

    toStringRepr() {
        return `|${this.dataChunks.map((s) => {
            if (s == "") return " ";
            else return ` ${s} `;
        }).join("|")}|`
    }

    toString() {
        return `ContentLine([${this.dataChunks}])`;
    }

    static tryParseAccordingToSepLine(line: string, sepLine: SeparatorLine) {
        if (!line.startsWith("|")) {
            throw new Error("Line doesn't match format! Should be '| content1 | content2 |'");
        }

        // Remove |
        line = line.substring(1);

        const parts = [];
        for (const colLength of sepLine.columnLengths) {
            const expectedLength = colLength + 1;
            const part = line.substring(0, expectedLength); // +1 to also grab the '|'
            if (part.length != expectedLength) {
                throw new Error("Line doesn't match format! Should be '| content1 | content2 |'");
            }
            if (part[part.length - 1] != "|") {
                continue;
            }
            let trimmed = part;

            trimmed = trimmed.substring(0, trimmed.length - 1);

            if (trimmed[0] == ' ') {
                trimmed = trimmed.substring(1);
            }

            if (trimmed[trimmed.length - 1] == ' ') {
                trimmed = trimmed.substring(0, trimmed.length - 1);
            }

            parts.push(trimmed);

            line = line.substring(expectedLength);
        }

        if (line.length != 0) {
            throw new Error("Line doesn't match format! Should be '| content1 | content2 |'");
        }

        return new ContentLine(parts);
    }
}

function lookAheadForTableParts(lines: Iterable<string>): (SeparatorLine | ContentLine)[] {
    const parts = [];
    let initialSeparatorLine = null;

    for (const line of lines) {
        if (initialSeparatorLine == null) {
            // First line
            try {
                initialSeparatorLine = SeparatorLine.tryParse(line);
                parts.push(initialSeparatorLine);
            } catch (e) {
                break;
            }
        } else {
            try {
                const potentialSeparator = SeparatorLine.tryParse(line);

                // No parse error was thrown
                parts.push(potentialSeparator);
                continue;
            } catch (e) {
                // Parse error
            }
            try {
                const potentialContentLine = ContentLine.tryParseAccordingToSepLine(line, initialSeparatorLine);

                // No parse error was thrown

                parts.push(potentialContentLine);
                continue;
            } catch (e) {
                // Parse error
            }

            // Line was neither content nor separator. End look-ahead and return parts.
            break;
        }
    }
    return parts;
}

function isValidTableSpec(parts: (SeparatorLine | ContentLine)[]): boolean {
    if (parts.length < 3) {
        console.debug("Less than 3 parts!");
        return false;
    }

    if (!(parts[0] instanceof SeparatorLine)) {
        console.debug("First line isn't a separator line!")
        return false;
    }
    if (!(parts[parts.length - 1] instanceof SeparatorLine)) {
        console.debug("Last line isn't a separator line! It is", parts[parts.length - 1]);
        return false;
    }
    const expectedColumns = parts[0].columnLengths;

    let separatorOk = false;

    for (let i = 1; i < parts.length; i++) {
        const entry = parts[i];

        if (entry instanceof SeparatorLine) {
            if (!separatorOk) {
                console.debug("Unexpected separator!");
                return false;
            }
            if (!entry.equals(parts[0])) {
                console.debug("Separator line doesn't match first one!")
                return false;
            }

            separatorOk = false;
        } else if (entry instanceof ContentLine) {
            for (let i = 0; i < expectedColumns.length; i++) {
                if (entry.dataChunks[i].length - expectedColumns[i] > 2) {
                    console.debug("Content length doesn't match expected column length!");
                    return false;
                }
            }

            separatorOk = true;
        }
    }

    return true;
}

function validSpecToTableContent(parts: (SeparatorLine | ContentLine)[]): TableContent {
    const rows = [];
    let newCellContents: string[][] = [];
    let isFirstSeparator = true;


    for (const entry of parts) {
        if (entry instanceof SeparatorLine) {
            if (!isFirstSeparator) {
                const cells = newCellContents.map((sArr) => sArr.join("\n")).map((celLContent) => new TableCell(celLContent));
                rows.push(new TableRow(cells));
            }
            isFirstSeparator = false;

            newCellContents = [];

            for (let i = 0; i < entry.columnLengths.length; i++) {
                newCellContents.push([]);
            }
        } else {
            for (let i = 0; i < entry.dataChunks.length; i++) {
                newCellContents[i].push(entry.dataChunks[i].trimEnd());
            }
        }
    }

    return new TableContent(rows);
}

function tryParseTableFromParsedParts(parts: (SeparatorLine | ContentLine)[]): TableContent {
    if (!isValidTableSpec(parts)) {
        throw new Error("Table format is invalid!");
    }

    return validSpecToTableContent(parts);
}

function tableContentToString(table: TableContent, baseSeparatorWidths?: number[], visualWidths?: number[]) {
	// colContentWidths holds the maximum visible content length per column (ignoring any padding).
	const colContentWidths: number[] = [];

	for (const row of table.rows) {
		for (let colIdx = 0; colIdx < row.cells.length; colIdx++) {
			if (colContentWidths.length <= colIdx) {
				colContentWidths.push(0);
			}
			const lines = row.cells[colIdx].content.split(/\n/);
			const lineLengths = lines.map((l) => l.length);
			const maxLineLength = Math.max(...lineLengths);

			if (maxLineLength > colContentWidths[colIdx]) {
				colContentWidths[colIdx] = maxLineLength;
			}
		}
	}

	let separatorWidths: number[];
	if (baseSeparatorWidths && baseSeparatorWidths.length > 0) {
		// Respect the separator widths we were given, but never make them
		// smaller than the actual content width + padding so the table always parses.
		separatorWidths = [];
		for (let colIdx = 0; colIdx < colContentWidths.length; colIdx++) {
			const contentWidth = colContentWidths[colIdx] || 0;
			let sepWidth = baseSeparatorWidths[colIdx] ?? 0;

			if (sepWidth <= 0) {
				// Fall back to the original behaviour for columns that don't have
				// an explicit base width.
				sepWidth = contentWidth == 0 ? 1 : contentWidth + 2;
			} else {
				// Ensure separator is at least as wide as content.
				// The minimum viable width is contentWidth itself (for tight fit),
				// but we need room for the padding spaces too.
				const minRequired = contentWidth === 0 ? 1 : contentWidth + 2;
				if (sepWidth < minRequired) {
					sepWidth = minRequired;
				}
			}

			separatorWidths.push(sepWidth);
		}
	} else {
		// Original behaviour: derive separator widths purely from content.
		separatorWidths = colContentWidths.map((w) => {
			if (w == 0) return 1;
			else return w + 2;
		});
	}

	const parts: (ContentLine | SeparatorLine)[] = [];

	// The actual padding width available in each column is:
	// separatorWidth - 2 (for the two spaces around content in | content |).
	// But if separator is only 1 character, we write | | with no content space.
	const paddingWidths: number[] = separatorWidths.map((sw) => (sw <= 1 ? 0 : sw - 2));

	// Visual widths are purely hints for layout; do not affect parsing.
	const visual = visualWidths && visualWidths.length > 0 ? visualWidths : null;

	for (const row of table.rows) {
		parts.push(new SeparatorLine(separatorWidths, visual));
		const rowLines = row.cells.map((cell) => cell.content.split("\n"));
		const numRows = Math.max(...rowLines.map((line) => line.length))

		for (let innerRowIdx = 0; innerRowIdx < numRows; innerRowIdx++) {
			const rowParts = [];
			for (let colIdx = 0; colIdx < rowLines.length; colIdx++) {
				const lines = rowLines[colIdx];
				const part = lines[innerRowIdx] || "";
				// Pad to the available space in the column.
				const paddedPart = part.padEnd(paddingWidths[colIdx], " ");

				rowParts.push(paddedPart);
			}
			parts.push(new ContentLine(rowParts));
		}
	}
	parts.push(new SeparatorLine(separatorWidths, visual));

	return parts.map((v) => v.toStringRepr()).join("\n");
}

export {
	SeparatorLine,
	ContentLine,
	lookAheadForTableParts,
	isValidTableSpec,
	tryParseTableFromParsedParts,
	tableContentToString,
}
