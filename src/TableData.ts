
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
}

export {
    TableContent,
    TableRow,
    TableCell,
}