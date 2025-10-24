import { TableCell, TableContent, TableRow } from "./TableData";

class SeparatorLine {
    columnLengths: number[]

    constructor(columnIndices: number[]) {
        if (columnIndices.length < 1) {
            throw new Error("columnIndices must not be empty!");
        }

        this.columnLengths = columnIndices;
    }

    equals(other: SeparatorLine) {
        return this.columnLengths.toString() === other.columnLengths.toString();
    }

    toString() {
        return `SeparatorLine([${this.columnLengths}])`
    }

    toStringRepr() {
        const parts = [];
        for (const length of this.columnLengths) {
            parts.push("-".repeat(length));
        }

        return `+${parts.join("+")}+`
    }

    static tryParse(line: string): SeparatorLine {
        if (!line.match(/^\+(-+\+)+$/)) {
            throw new Error("Line doesn't match format! Should look like this: '+--+---+-+'!")
        }

        const lengths = line
            .split("+")
            .slice(1, -1)
            .map((s) => s.length);

        return new SeparatorLine(lengths);
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
    if (parts.length < 3) return false;

    if (!(parts[0] instanceof SeparatorLine)) return false;
    if (!(parts[parts.length - 1] instanceof SeparatorLine)) return false;
    const expectedColumns = parts[0].columnLengths;

    let separatorOk = false;

    for (let i = 1; i < parts.length; i++) {
        const entry = parts[i];

        if (entry instanceof SeparatorLine) {
            if (!separatorOk) return false;
            if (!entry.equals(parts[0])) return false;

            separatorOk = false;
        } else if (entry instanceof ContentLine) {
            for (let i = 0; i < expectedColumns.length; i++) {
                if (entry.dataChunks[i].length - expectedColumns[i] > 2) {
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

function tableContentToString(table: TableContent) {
    const colWidths = [];

    for (const row of table.rows) {
        for (let colIdx = 0; colIdx < row.cells.length; colIdx++) {
            if (colWidths.length <= colIdx) {
                colWidths.push(0);
            }
            const lines = row.cells[colIdx].content.split(/\n/);
            const lineLengths = lines.map((l) => l.length);
            const maxLineLength = Math.max(...lineLengths);

            if (maxLineLength > colWidths[colIdx]) {
                colWidths[colIdx] = maxLineLength;
            }
        }
    }

    const paddedColWidths = colWidths.map((w) => {
        if (w == 0) return 1;
        else return w + 2;
    });
    const parts: (ContentLine | SeparatorLine)[] = [];

    for (const row of table.rows) {
        parts.push(new SeparatorLine(paddedColWidths));
        const rowLines = row.cells.map((cell) => cell.content.split("\n"));
        const numRows = Math.max(...rowLines.map((line) => line.length))

        for (let innerRowIdx = 0; innerRowIdx < numRows; innerRowIdx++) {
            const rowParts = [];
            for (let colIdx = 0; colIdx < rowLines.length; colIdx++) {
                const lines = rowLines[colIdx];
                const part = lines[innerRowIdx] || "";
                const paddedPart = part.padEnd(colWidths[colIdx], " ");

                rowParts.push(paddedPart);
            }
            parts.push(new ContentLine(rowParts));
        }
    }
    parts.push(new SeparatorLine(paddedColWidths));

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