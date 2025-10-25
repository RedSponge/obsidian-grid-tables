
class TableCell {
    content: string

    constructor(content: string) {
        this.content = content;
    }

    toString() {
        return `TableCell("${this.content}")`
    }
}


class TableRow {
    cells: TableCell[]

    get length() {
        return this.cells.length;
    }

    constructor(cells: TableCell[]) {
        this.cells = cells;
    }

    toString() {
        return `TableRow([${this.cells}])`
    }
}

class TableContent {
    rows: TableRow[]

    constructor(rows: TableRow[]) {
        this.rows = rows;
    }
    toString() {
        return `TableContent([${this.rows}])`
    }

    get columnCount() {
        return this.rows[0].length;
    }

    get rowCount() {
        return this.rows.length
    }

    addRow(length: number | undefined = undefined): TableRow {
        if (length == undefined) {
            if (this.rows.length == 0) {
                throw new Error("Length of row must be specified for an empty table!");
            }
            length = this.rows[0].cells.length;
        }

        const newRow = new TableRow(Array(length).fill("").map((s) => new TableCell(s)))
        this.rows.push(newRow);

        return newRow;
    }
}

export {
    TableContent,
    TableRow,
    TableCell,
}