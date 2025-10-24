import { TableCell, TableContent, TableRow } from "../src/TableData";
import { ContentLine, isValidTableSpec, lookAheadForTableParts, SeparatorLine, tableContentToString, tryParseTableFromParsedParts } from "../src/TableSerde"

describe("SeparatorLine.toStringRepr", () => {
    it.each([
        [[3], "+---+"],
        [[1, 1], "+-+-+"],
        [[1, 2, 3], "+-+--+---+"],
    ])("%s", (columnLengths, expectedRepr) => {
        expect(new SeparatorLine(columnLengths).toStringRepr()).toEqual(expectedRepr);
    })
});

describe("SeparatorLine constructor", () => {
    test("Empty List", () => {
        expect(() => { new SeparatorLine([]) }).toThrow(new Error("columnIndices must not be empty!"))
    })
});

describe("SeparatorLine parsing", () => {
    it.each([
        ["+-+", [1]],
        ["+--+----+", [2, 4]],
    ])("%s", (toParse, expectedColumns) => {
        expect(SeparatorLine.tryParse(toParse).columnLengths).toEqual(expectedColumns);
    });

    it.each([
        [""],
        ["+-"],
        ["-+"],
        ["+-+-"],
        ["+-hi-+"],
    ])("Bad format '%s'", (s) => {
        expect(() => SeparatorLine.tryParse(s)).toThrow(new Error("Line doesn't match format! Should look like this: '+--+---+-+'!"))
    })
});

describe("ContentLine.toStringRepr", () => {
    it.each([
        [["a"], "| a |"],
        [["con", "tent"], "| con | tent |"],
        [["con", "", "tent"], "| con | | tent |"],
        [["", "", ""], "| | | |"],
        [[""], "| |"],
    ])("%s", (chunks, expectedRepr) => {
        expect(new ContentLine(chunks).toStringRepr()).toEqual(expectedRepr);
    });
});

describe("ContentLine.tryParseAccordingToSepLine", () => {
    it.each([
        ["| hey | a |", SeparatorLine.tryParse("+-----+---+"), ["hey", "a"]],
        ["|hey|a|", SeparatorLine.tryParse("+---+-+"), ["hey", "a"]],
        ["| hey|a |", SeparatorLine.tryParse("+----+--+"), ["hey", "a"]],
        ["| hey  |a |", SeparatorLine.tryParse("+------+--+"), ["hey ", "a"]],
        ["| hey | b | c |", SeparatorLine.tryParse("+-----+---+---+"), ["hey", "b", "c"]],
        ["| x|x | b | c |", SeparatorLine.tryParse("+-----+---+---+"), ["x|x", "b", "c"]],
    ])("Valid parse: '%s'", (contentLine, sepLine, expectedParts) => {
        expect(ContentLine.tryParseAccordingToSepLine(contentLine, sepLine).dataChunks).toEqual(expectedParts)
    })

    it.each([
        ["", SeparatorLine.tryParse("+-+")],
        ["|a", SeparatorLine.tryParse("+-+")],
        ["a|", SeparatorLine.tryParse("+-+")],
        ["|a|", SeparatorLine.tryParse("+--+")],
        ["|a|", SeparatorLine.tryParse("+--+")],
        ["|a|b|", SeparatorLine.tryParse("+-+")],
    ])("Invalid parse: '%s'", (contentLine, sepLine) => {
        expect(() => ContentLine.tryParseAccordingToSepLine(contentLine, sepLine)).toThrow(new Error("Line doesn't match format! Should be '| content1 | content2 |'"));
    })
});

describe("lookAheadForTableParts", () => {
    test("Valid", () => {
        expect(
            lookAheadForTableParts([
                "+-+--+",
                "|a|b1|",
                "+-+--+",
                "|c|d2|",
                "|e|f1|",
                "+-+--+",
            ])
        ).toStrictEqual([
            new SeparatorLine([1, 2]),
            new ContentLine(["a", "b1"]),
            new SeparatorLine([1, 2]),
            new ContentLine(["c", "d2"]),
            new ContentLine(["e", "f1"]),
            new SeparatorLine([1, 2]),
        ]);
    });

    test("Valid with garbage", () => {
        expect(
            lookAheadForTableParts([
                "+-+--+",
                "|a|b1|",
                "+-+--+",
                "|c|d2|",
                "|e|f1|",
                "+-+--+",
                "meow",
            ])
        ).toStrictEqual([
            new SeparatorLine([1, 2]),
            new ContentLine(["a", "b1"]),
            new SeparatorLine([1, 2]),
            new ContentLine(["c", "d2"]),
            new ContentLine(["e", "f1"]),
            new SeparatorLine([1, 2]),
        ]);
    });

    test("Garbage at the beginning", () => {
        expect(
            lookAheadForTableParts([
                "hi",
                "+-+--+",
                "|a|b1|",
                "+-+--+",
            ])
        ).toStrictEqual([]);
    })
    test("Different separators", () => {
        expect(
            lookAheadForTableParts([
                "+-+--+",
                "|a|b1|",
                "+-+---+",
                "|c|d2|",
                "|e|f1|",
                "+---+--+",
            ])
        ).toStrictEqual([
            new SeparatorLine([1, 2]),
            new ContentLine(["a", "b1"]),
            new SeparatorLine([1, 3]),
            new ContentLine(["c", "d2"]),
            new ContentLine(["e", "f1"]),
            new SeparatorLine([3, 2]),
        ]);
    });
    test("Content line not matching initial separator", () => {
        expect(
            lookAheadForTableParts([
                "+-+--+",
                "|a|b1|",
                "+-+--+",
                "|c|d 2|",
                "|e|f1|",
                "+---+--+",
            ])
        ).toStrictEqual([
            new SeparatorLine([1, 2]),
            new ContentLine(["a", "b1"]),
            new SeparatorLine([1, 2]),
        ]);
    });
});

describe("isValidTableSpec", () => {
    test("Fully Padded", () => {
        expect(isValidTableSpec([
            new SeparatorLine([3, 3]),
            new ContentLine(["a", "b"]),
            new SeparatorLine([3, 3]),
        ])).toBe(true);
    });
    test("Missing padding", () => {
        expect(isValidTableSpec([
            new SeparatorLine([2, 1]),
            new ContentLine(["a", "b"]),
            new SeparatorLine([2, 1]),
        ])).toBe(true);
    });
    test("Empty cell", () => {
        expect(isValidTableSpec([
            new SeparatorLine([2, 3]),
            new ContentLine(["", " b "]),
            new SeparatorLine([2, 3]),
        ])).toBe(true);
    });
    test("Actual mismatch", () => {
        expect(isValidTableSpec([
            new SeparatorLine([4, 4]),
            new ContentLine(["a", "b"]),
            new SeparatorLine([2, 1]),
        ])).toBe(false);
    });
})


describe("tryParseTableFromParsedParts", () => {
    test("Sanity", () => {
        expect(tryParseTableFromParsedParts([
            new SeparatorLine([4, 6]),
            new ContentLine(["hi", "ther"]),
            new ContentLine(["yo", "eyou"]),
            new SeparatorLine([4, 6]),
            new ContentLine(["wo", "ohoo"]),
            new SeparatorLine([4, 6]),
        ])).toStrictEqual(new TableContent([
            new TableRow([new TableCell("hi\nyo"), new TableCell("ther\neyou")]),
            new TableRow([new TableCell("wo"), new TableCell("ohoo")]),
        ]))
    });
    test("Trimming", () => {
        expect(tryParseTableFromParsedParts([
            new SeparatorLine([4, 6]),
            new ContentLine(["hi", "th  "]),
            new ContentLine(["yo", "eyou"]),
            new SeparatorLine([4, 6]),
            new ContentLine(["wo", "ohoo"]),
            new SeparatorLine([4, 6]),
        ])).toStrictEqual(new TableContent([
            new TableRow([new TableCell("hi\nyo"), new TableCell("th\neyou")]),
            new TableRow([new TableCell("wo"), new TableCell("ohoo")]),
        ]))
    })
})

describe("tableContentToString", () => {
    test("Sanity", () => {
        expect(tableContentToString(new TableContent([
            new TableRow([
                new TableCell("ab\ncd"),
                new TableCell("x")
            ]),
            new TableRow([
                new TableCell("a\nb\nc"),
                new TableCell("woohoo")
            ]),
        ]))).toEqual(
            "+----+--------+\n" +
            "| ab | x      |\n" +
            "| cd |        |\n" +
            "+----+--------+\n" +
            "| a  | woohoo |\n" +
            "| b  |        |\n" +
            "| c  |        |\n" +
            "+----+--------+"
        );
    })
    test("Sanity2", () => {
        expect(tableContentToString(new TableContent([
            new TableRow([
                new TableCell("\n"),
                new TableCell("x")
            ]),
            new TableRow([
                new TableCell(""),
                new TableCell("woohoo")
            ]),
        ]))).toEqual(
            "+-+--------+\n" +
            "| | x      |\n" +
            "| |        |\n" +
            "+-+--------+\n" +
            "| | woohoo |\n" +
            "+-+--------+"
        );
    })
    test("Sanity3", () => {
        expect(tableContentToString(new TableContent([
            new TableRow([
                new TableCell(""),
                new TableCell("b")
            ]),
        ]))).toEqual(
            "+-+---+\n" +
            "| | b |\n" +
            "+-+---+"
        );
    })
})