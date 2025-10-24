import { App, Editor, editorEditorField, editorInfoField, editorLivePreviewField, livePreviewState, MarkdownEditView, MarkdownRenderer, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { EditorState, Extension, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state"
import { Decoration, DecorationSet, EditorView, keymap, PluginSpec, PluginValue, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language';
import { table } from 'console';
import { test, createFunc } from 'sloppy'
import { lookAheadForTableParts, SeparatorLine, tableContentToString, tryParseTableFromParsedParts } from 'src/TableSerde';
import { TableContent } from 'src/TableData';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default'
}

const addEffect = StateEffect.define<number>();
const subtractEffect = StateEffect.define<number>();
const resetEffect = StateEffect.define();

export const calculatorField = StateField.define<number>({
	create(state: EditorState): number {
		return 0;
	},
	update(oldState: number, transaction: Transaction): number {
		let newState = oldState;

		for (const effect of transaction.effects) {
			if (effect.is(addEffect)) {
				newState += effect.value;
			} else if (effect.is(subtractEffect)) {
				newState -= effect.value;
			} else if (effect.is(resetEffect)) {
				newState = 0;
			}
		}

		return newState;
	},
});

export class TestWidget extends WidgetType {
	toDOM(view: EditorView): HTMLElement {
		const div = document.createElement("span");
		if (globalApp == null) {
			div.innerText = "Loading...";
		} else {
			MarkdownRenderer.render(globalApp, "- [ ] Hello", div, ".", this);
		}
		return div;
	}
}

function getMarkdownEditorClass(app: any) {
	const md = app.embedRegistry.embedByExtension.md(
		{ app: app, containerEl: createDiv(), state: {} },
		null,
		''
	);

	md.load();
	md.editable = true;
	md.showEditor();

	const MarkdownEditor = Object.getPrototypeOf(Object.getPrototypeOf(md.editMode)).constructor;

	md.unload();

	return MarkdownEditor;
}

function getTableCellEditorClass(superclass: any) {
	class TableCellEditor extends superclass {
		isCellEditor = true;

		updateBottomPadding() { }
		onUpdate(update: ViewUpdate, changed: boolean) {
			super.onUpdate(update, changed)
			this.onChange && this.onChange(update);
		}
		buildLocalExtensions(): Extension[] {
			const extensions = super.buildLocalExtensions();
			// TODO: Hook into events here like Kanban does, to handle paste and so on.
			return extensions;
		}
	}

	return TableCellEditor
}

function noop() { }

function getMarkdownController(app: any, file: TFile, getEditor: () => Editor) {
	return {
		app,
		showSearch: noop,
		toggleMode: noop,
		onMarkdownScroll: noop,
		getMode: () => 'source',
		scroll: 0,
		editMode: null,
		get editor() {
			return getEditor()
		},
		get file() {
			// TODO
			return file;
		},
		get path() {
			return file.path;
		}
	}
}

export class GribTableWidget extends WidgetType {
	table: TableContent
	from: number
	to: number
	file: TFile
	editors: any[]

	constructor(table: TableContent, file: TFile, originalFrom: number, originalTo: number) {
		super()
		this.table = table;
		this.from = originalFrom;
		this.to = originalTo;
		this.file = file;
		this.editors = [];
	}
	updateDOM(dom: HTMLElement, view: EditorView): boolean {
		return true;
	}
	toDOM(view: EditorView): HTMLElement {
		const div = document.createElement("div");
		if (globalApp == null) {
			div.innerText = "Loading...";
			return div;
		}

		const table = document.createElement("table");

		for (const row of this.table.rows) {
			const tr = document.createElement("tr");
			for (const cell of row.cells) {
				const td = document.createElement("td");
				td.style.border = "1px solid white";
				td.style.width = "200px";


				const containingDiv = document.createElement("div");

				const extensions = view.state.config;

				const MarkdownEditor = getMarkdownEditorClass(globalApp);
				const TableCellEditor = getTableCellEditorClass(MarkdownEditor);
				const controller = getMarkdownController(globalApp, this.file, () => editor.editor)
				const editor = new TableCellEditor(globalApp, containingDiv, controller);

				editor.onChange = (up: ViewUpdate) => {
					if (up.docChanged) {
						const newContent = up.state.doc.toString();
						console.log(`Edit in cell originally containing ${cell.content}. It now contains ${newContent}! Syncing!`);
						cell.content = newContent;

						const from = this.from;
						const to = this.to;
						const newTableRepr = tableContentToString(this.table) + "\n";
						view.dispatch({
							changes: { from: from, to: to, insert: newTableRepr }
						})
						console.log(`Previous: ${this.from} to=${this.to}`)
						this.to = this.from + newTableRepr.length;
						console.log(`New: ${this.to}`)
						console.log(up.state.doc.toString());
					}
				}
				// editor.editor.removeHighlights = () => { console.log("Should remove highlights! ") };
				globalPlugin?.addChild(editor);
				this.editors.push(editor);

				controller.editMode = editor;
				editor.set(cell.content);

				td.appendChild(containingDiv);
				tr.appendChild(td);
			}
			table.appendChild(tr);
		}

		div.appendChild(table);

		return div;
	}
	destroy(dom: HTMLElement): void {
		for (const editor of this.editors) {
			globalPlugin?.removeChild(editor);
		}
		this.editors = [];
	}
}

// class TableCell {
// 	content: string

// 	constructor() {
// 		this.content = "";
// 	}
// }

// class TableRow {
// 	cells: TableCell[]
// 	constructor() {
// 		this.cells = [];
// 	}
// }

// class TableContent {
// 	rows: TableRow[]
// 	constructor() {
// 		this.rows = [];
// 	}

// 	toStringRepr() {
// 		const colWidths = [];

// 		for (const row of this.rows) {
// 			for (let colIdx = 0; colIdx < row.cells.length; colIdx++) {
// 				if (colWidths.length <= colIdx) {
// 					colWidths.push(0);
// 				}
// 				const lines = row.cells[colIdx].content.split(/\n/);
// 				const lineLengths = lines.map((l) => l.length);
// 				const maxLineLength = Math.max(...lineLengths);

// 				if (maxLineLength > colWidths[colIdx]) {
// 					colWidths[colIdx] = maxLineLength;
// 				}
// 			}
// 		}

// 		const lines = [];
// 		const separatorParts = ["+"];
// 		for (const colWidth of colWidths) {
// 			separatorParts.push("-".repeat(colWidth + 2))
// 			separatorParts.push("+");
// 		}

// 		const separator = separatorParts.join("");

// 		for (const row of this.rows) {
// 			lines.push(separator)

// 			const rowLines = row.cells.map((cell) => cell.content.split(/\n/));
// 			console.log(rowLines);
// 			const numRows = Math.max(...rowLines.map((lines) => lines.length));
// 			console.log(numRows);

// 			for (let innerRowIdx = 0; innerRowIdx < numRows; innerRowIdx++) {
// 				const rowParts = [];
// 				for (let colIdx = 0; colIdx < rowLines.length; colIdx++) {
// 					const lines = rowLines[colIdx];
// 					const part = lines[innerRowIdx] || "";
// 					const paddedPart = part.padEnd(colWidths[colIdx], " ");

// 					rowParts.push(paddedPart)
// 				}
// 				lines.push("| " + rowParts.join(" | ") + " |");
// 			}
// 		}
// 		lines.push(separator);
// 		const repr = lines.join("\n").trim();
// 		console.log(repr);
// 		return repr;
// 	}
// }

// class SeparatorLine {
// 	columnLengths: number[]

// 	constructor(columnIndices: number[]) {
// 		if (columnIndices.length < 1) {
// 			throw new Error("columnIndices must not be empty!");
// 		}

// 		this.columnLengths = columnIndices;
// 	}

// 	toStringRepr() {
// 		const parts = [];
// 		for (const length of this.columnLengths) {
// 			parts.push("-".repeat(length));
// 		}

// 		return `+${parts.join("+")}+`
// 	}

// 	static tryParse(line: string) {
// 		line.split("+")
// 	}
// }

// class ParsedContentLine {
// 	contents: string[]

// 	constructor(contents: string[]) {
// 		this.contents = contents;
// 	}
// }

// function isValidTableSpec(parsed: (SeparatorLine | ParsedContentLine)[]): boolean {
// 	if (parsed.length < 3) return false;

// 	// console.log("Top check")
// 	if (!(parsed[0] instanceof SeparatorLine)) return false;
// 	// console.log("Bottom check")
// 	if (!(parsed[parsed.length - 1] instanceof SeparatorLine)) return false;
// 	const expectedColumns = parsed[0].columnCount;
// 	let separatorOk = false;

// 	for (let i = 1; i < parsed.length; i++) {
// 		const entry = parsed[i];
// 		if (entry instanceof SeparatorLine) {
// 			// console.log("Checking separator..")
// 			if (!separatorOk) {
// 				// console.log("Separator wasn't ok!");
// 				return false;
// 			}
// 			// console.log("Separator was ok");
// 			separatorOk = false;
// 		} else if (entry instanceof ParsedContentLine) {
// 			// console.log("Checking ParsedContentLine");
// 			if (entry.contents.length != expectedColumns) {
// 				// console.log("Bad lengths!");
// 				return false;
// 			}
// 			// console.log("Content was ok. Marking separatorOk=true");
// 			separatorOk = true;
// 		}
// 	}

// 	return true;
// }

// function tableSpecToTableContent(validSpec: (SeparatorLine | ParsedContentLine)[]): TableContent {
// 	const content = new TableContent();

// 	for (const entry of validSpec) {
// 		if (entry instanceof SeparatorLine) {
// 			const newRow = new TableRow();
// 			for (let i = 0; i < entry.columnCount; i++) {
// 				newRow.cells.push(new TableCell());
// 			}
// 			content.rows.push(newRow);
// 		} else {
// 			const row = content.rows[content.rows.length - 1];
// 			for (let i = 0; i < entry.contents.length; i++) {
// 				row.cells[i].content += entry.contents[i].trim() + "\n";
// 			}
// 		}
// 	}

// 	// Remove last constructed row because it's the last separator line.
// 	// TODO: don't even construct it.
// 	content.rows.pop();

// 	return content;
// }

let globalApp: App | null = null;

function* accessIterator<T>(whole: (index: number) => T, startIndex: number, maxIndex: number) {
	for (let index = startIndex; index < maxIndex; index++) {
		yield whole(index);
	}
}


// function tryParsingTable(lineIterator: Iterable<string>) {
// 	let columnIndexes = undefined;

// 	for (const line of lineIterator) {
// 		// First line
// 		if (columnIndexes == undefined) {

// 		}

// 	}
// }

const tableField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none
	},
	update(oldState: DecorationSet, tr: Transaction): DecorationSet {

		// if (!tr.docChanged) {
		// 	return oldState.map(tr.changes);
		// }
		const mdInfo = tr.state.field(editorInfoField);
		const fileRef = mdInfo.file;
		const view = tr.state.field(editorEditorField);
		const livePreview = view.state.field(editorLivePreviewField);
		const isSourceMode = !livePreview;


		const builder = new RangeSetBuilder<Decoration>();
		// const lines = []
		let index = 1;
		const potentialTables = [];
		let scannedUpTo = 0;
		for (const line of tr.state.doc.iterLines()) {
			try {
				SeparatorLine.tryParse(line);
				potentialTables.push(index);
			} catch (e) { }
			index++;
		}

		for (const tableStartLine of potentialTables) {

			// If range is already part of previous table.
			if (tableStartLine <= scannedUpTo) {
				// console.log(`Skipping ${lineIndex} because it's less than ${scannedUpTo}`)
				continue;
			} else {
				// console.log(`Not skipping ${lineIndex}`)
			}

			const parts = lookAheadForTableParts(
				accessIterator(
					(index) => tr.state.doc.line(index).text,
					tableStartLine,
					tr.startState.doc.lines
				)
			);
			console.log(parts);

			try {
				console.log("Trying to parse..");
				const table = tryParseTableFromParsedParts(parts);
				console.log("Found a table!");
				const tableEndLine = tableStartLine + parts.length - 1;
				const from = tr.state.doc.line(tableStartLine).from;
				const to = tr.state.doc.line(tableEndLine).to + 1;

				if (isSourceMode) {
					builder.add(from, to, Decoration.mark({ class: 'HyperMD-table-row' }))
				} else {
					builder.add(from, to, Decoration.replace({
						widget: new GribTableWidget(table, fileRef, from, to)
					}));
				}

				scannedUpTo = tableEndLine;
			} catch (e) { }

			// while (lineIndex < tr.state.doc.lines) {
			// 	const line = tr.state.doc.line(lineIndex);
			// 	const text = line.text;
			// 	if (text.length == 0) break;

			// 	if (text.match(/(\+-+)+\+/)) {
			// 		const parts = text.split("+").length - 2;
			// 		parsedLines.push(new SeparatorLine(parts));
			// 	} else if (text.match(/(|.+)+|/)) {
			// 		const parts = text.split("|");
			// 		const withoutEdges = parts.slice(1, -1);
			// 		parsedLines.push(new ParsedContentLine(withoutEdges));

			// 	}
			// 	lineIndex++;
			// }

			// const tableStartLine = tableStartLine;
			// const tableEndLine = lineIndex - 1;

			// if (isValidTableSpec(parsedLines)) {
			// 	const table = tableSpecToTableContent(parsedLines);
			// 	const from = tr.state.doc.line(tableStartLine).from;
			// 	const to = tr.state.doc.line(tableEndLine).to;

			// 	if (isSourceMode) {
			// 		builder.add(from, to, Decoration.mark({ class: 'HyperMD-table-row' }))
			// 	} else {
			// 		builder.add(from, to, Decoration.replace({
			// 			widget: new GribTableWidget(table, fileRef, from, to)
			// 		}));
			// 	}
			// 	// console.log(`Found table at lines ${tableIndex}-${lineIndex}! Marking lines as non-tablale`);
			// 	scannedUpTo = tableEndLine;
			// }
		}
		return builder.finish();
	},
	provide(field: StateField<DecorationSet>): Extension {
		// console.log("Provide decorations");
		return EditorView.decorations.from(field);
	},
});


let globalPlugin: MyPlugin | null = null;

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		globalPlugin = this;
		// this.app
		// const previousCreate = EditorState.create;
		// EditorState.create = createFunc(EditorState);
		// EditorState.create = function (config) {
		// 	test(EditorState.create);
		// 	if (config?.extensions) {
		// 		let globalExtensionSpec = config.extensions
		// 	}
		// 	console.log(`Creating new state with ${config?.extensions}`);
		// 	return previousCreate.call(EditorState, config);
		// }
		globalApp = this.app;
		await this.loadSettings();
		this.registerEditorExtension(tableField);


		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Setting #1')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
	}
}
