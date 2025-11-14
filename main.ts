import { App, Editor, editorEditorField, editorInfoField, editorLivePreviewField, MarkdownPostProcessorContext, MarkdownRenderer, MarkdownView, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { Extension, Facet, Prec, RangeSetBuilder, StateField, Transaction } from "@codemirror/state"
import { Command, Decoration, DecorationSet, EditorView, keymap, WidgetType } from '@codemirror/view'
import { lookAheadForTableParts, SeparatorLine, tableContentToString, tryParseTableFromParsedParts } from 'src/TableSerde';
import { TableCell, TableContent, TableRow } from 'src/TableData';
import { ObsidianEditorAdapter } from 'src/ObsidianEditorAdapter';
import { EDITOR_TABLE_ADD_COLUMN_BUTTON_CLASS, EDITOR_TABLE_ADD_ROW_BUTTON_CLASS, EDITOR_TABLE_BUTTON_CLASS, EDITOR_TABLE_CELL_CLASS, EDITOR_TABLE_CLASS, EDITOR_TABLE_CONTAINER_CLASS, EDITOR_TABLE_ROW_CLASS, PLUS_SVG } from 'src/consts';
import { BiMap } from 'src/BiMap';

// Remember to rename these classes and interfaces!

function trimLines(str: string): string {
	return str.split("\n").map((s) => s.trim()).join("\n");
}

interface GridTablePluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: GridTablePluginSettings = {
	mySetting: 'default'
}

function* enumerate<T>(iter: Iterable<T>): Generator<[number, T]> {
	let index = 0;
	for (const t of iter) {
		yield [index, t];
		index++;
	}
}

function moveCursorToEnd(view: EditorView) {
	view.dispatch({
		selection: {
			head: view.state.doc.length,
			anchor: view.state.doc.length,
		}
	})
}

function moveCursorToBeginning(view: EditorView) {
	view.dispatch({
		selection: {
			head: 0,
			anchor: 0,
		}
	})
}

function triggerCodeMirrorKey(view: EditorView, keyString: string) {
	const bindings = view.state.facet(keymap).flat();
	for (const binding of bindings) {
		if (binding.key == keyString) {
			if (binding.run && binding.run(view)) {
				return true;
			}
		}
	}

	return false;
}

function genKeyForwarder(forwardTo: EditorView, keys: string[]) {
	return Prec.highest(
		keymap.of(keys.map((key) => {
			return {
				key,
				run() {
					return triggerCodeMirrorKey(forwardTo, key)
				},
				preventDefault: true,
			}
		}))
	)
}

class ObsidianEditorStorage {
	static uids: number

	editors: BiMap<Element, ObsidianEditorAdapter>
	plugin: Plugin
	uid: number

	constructor(plugin: Plugin) {
		this.plugin = plugin;
		this.editors = new BiMap();

		if (ObsidianEditorStorage.uids == undefined) {
			ObsidianEditorStorage.uids = 0;
		}

		this.uid = ObsidianEditorStorage.uids++;
	}

	newEditor(extensions: () => Extension[], file: TFile): [Element, ObsidianEditorAdapter] {
		const editor = new ObsidianEditorAdapter(this.plugin);
		editor.setExtraExtensionProvider(extensions)

		const containingElement = document.createElement("div");
		editor.mount(containingElement, file)

		this.editors.set(containingElement, editor)

		return [containingElement, editor];
	}

	getEditorByElement(element: Element): ObsidianEditorAdapter | undefined {
		return this.editors.get(element);
	}

	getElementByEditor(editor: ObsidianEditorAdapter): Element | undefined {
		return this.editors.getByValue(editor);
	}

	delEditor(editor: ObsidianEditorAdapter): void {
		editor.unmount();
		this.editors.deleteByValue(editor);
	}

	toString() {
		return `ObsidianEditorStorage(uid=${this.uid})`
	}
}

function getAttrOrErr(el: Element, attrName: string): string {
	const attr = el.getAttr(attrName);
	if (attr == null) {
		throw new Error(`Element doesn't contain attribute ${attrName}`)
	}

	return attr;
}

class TableAttributes {
	static readonly ATTRIBUTE_SOURCE_LENGTH = "source-length";
	static readonly ATTRIBUTE_COLS = "cols";
	static readonly ATTRIBUTE_ROWS = "rows";

	sourceLength: number
	cols: number
	rows: number

	constructor(sourceLength: number, cols: number, rows: number) {
		this.sourceLength = sourceLength;
		this.cols = cols;
		this.rows = rows;
	}

	write(el: Element) {
		el.setAttribute(TableAttributes.ATTRIBUTE_SOURCE_LENGTH, this.sourceLength.toString());
		el.setAttribute(TableAttributes.ATTRIBUTE_COLS, this.cols.toString());
		el.setAttribute(TableAttributes.ATTRIBUTE_ROWS, this.rows.toString());
	}

	static read(el: Element): TableAttributes {
		return new TableAttributes(
			parseInt(getAttrOrErr(el, TableAttributes.ATTRIBUTE_SOURCE_LENGTH)),
			parseInt(getAttrOrErr(el, TableAttributes.ATTRIBUTE_COLS)),
			parseInt(getAttrOrErr(el, TableAttributes.ATTRIBUTE_ROWS)),
		)
	}
}

class TableCellAttributes {
	static readonly ATTRIBUTE_COL = "col";
	static readonly ATTRIBUTE_ROW = "row";
	static readonly ATTRIBUTE_TAB_INDEX = "tab-index";

	readonly col: number
	readonly row: number
	readonly tabIndex: number

	constructor(col: number, row: number, tabIndex: number) {
		this.col = col;
		this.row = row;
		this.tabIndex = tabIndex;
	}

	write(el: Element): void {
		el.setAttribute(TableCellAttributes.ATTRIBUTE_COL, this.col.toString());
		el.setAttribute(TableCellAttributes.ATTRIBUTE_ROW, this.row.toString());
		el.setAttribute(TableCellAttributes.ATTRIBUTE_TAB_INDEX, this.tabIndex.toString());
	}

	static read(el: Element): TableCellAttributes {
		return new TableCellAttributes(
			parseInt(getAttrOrErr(el, TableCellAttributes.ATTRIBUTE_COL)),
			parseInt(getAttrOrErr(el, TableCellAttributes.ATTRIBUTE_ROW)),
			parseInt(getAttrOrErr(el, TableCellAttributes.ATTRIBUTE_TAB_INDEX)),
		)
	}
}


function suggestWidth(content: string, sourcePath: string, container: HTMLElement) {
	const longestLine = content.split("\n").reduce((a, b, i, ar) => a.length > b.length ? a : b);
	return `${Math.max(longestLine.length + 4, 5)}ch`
}

const nestedEditorsFacet = Facet.define<ObsidianEditorStorage>();

export class GridTableWidget extends WidgetType {
	static uids: number

	readonly contentToWriteToState: TableContent
	readonly originalLength: number

	file: TFile
	uid: number
	editorStorage: ObsidianEditorStorage

	constructor(contentToWriteToState: TableContent, file: TFile, originalLength: number) {
		super()
		this.contentToWriteToState = contentToWriteToState;
		this.file = file;
		this.originalLength = originalLength;

		if (GridTableWidget.uids == undefined) {
			GridTableWidget.uids = 0;
		}

		this.uid = GridTableWidget.uids++;
	}

	loadEditors(view: EditorView) {
		const [editors] = view.state.facet(nestedEditorsFacet);

		this.editorStorage = editors;
	}

	updateDOM(dom: HTMLElement, view: EditorView): boolean {
		this.loadEditors(view);

		const tableEl = dom.querySelector('table');
		if (tableEl == null) return false;
		if (!globalPlugin) return false;

		GridTableWidget.syncDomTableWithContent(view, tableEl, this.contentToWriteToState, this.originalLength, this.file, globalPlugin);

		return true;
	}

	static getIndexOfEditor(editor: ObsidianEditorAdapter): number {
		if (!editor.parentElement.parentElement) {
			throw new Error();
		}

		const data = TableCellAttributes.read(editor.parentElement.parentElement);
		return data.tabIndex;
	}

	static genTabHandler(shift: boolean, editor: ObsidianEditorAdapter, view: EditorView, containingTable: HTMLTableElement, file: TFile): Command {
		return (_cellView: EditorView) => {
			const myIndex = GridTableWidget.getIndexOfEditor(editor);

			if (myIndex == -1) {
				console.warn("Cell isn't part of known editors, so skipping it!");
				return false;
			}

			const direction = shift ? -1 : 1;

			if (!this.tryShiftFromBy(view, containingTable, editor, direction)) {
				if (direction == 1) {
					this.addRow(view, containingTable, file);
					// Try shifting now that new cell was created.
					this.tryShiftFromBy(view, containingTable, editor, 1);
				} else {
					console.warn("Doing nothing!");
				}
			}

			return true;
		}
	}

	static addRow(view: EditorView, containingTable: HTMLTableElement, file: TFile) {
		const newRow = new TableRow(Array.from({ length: TableAttributes.read(containingTable).cols }, () => new TableCell("")));
		const newTR = this.constructRow(newRow, view, containingTable, file)
		containingTable.appendChild(newTR);
		this.flushToFile(view, containingTable);
	}

	static genTrEl() {
		const tr = document.createElement("tr");
		tr.classList.add(EDITOR_TABLE_ROW_CLASS);
		return tr;
	}

	static constructRow(row: TableRow, view: EditorView, containingTable: HTMLTableElement, file: TFile) {
		const tr = this.genTrEl();

		for (const cell of row.cells) {
			const [td, editor] = this.constructCell(view, containingTable, file);

			editor.setContent(cell.content);
			tr.appendChild(td);
		}

		return tr;
	}

	static tryShiftFromBy(view: EditorView, tableElement: HTMLTableElement, fromEditor: ObsidianEditorAdapter, byAmount: number, newCellCallback: ((newEditor: EditorView) => void) | undefined = undefined): boolean {
		const [editors] = view.state.facet(nestedEditorsFacet);

		const editorIndex = GridTableWidget.getIndexOfEditor(fromEditor);
		if (editorIndex == -1) return false;
		const desired = editorIndex + byAmount;
		const [desiredEl] = Array.from(tableElement.querySelectorAll(`:scope > tr > td[tab-index="${desired}"] > div`));
		if (desiredEl == undefined) {
			return false;
		}
		const editor = editors.getEditorByElement(desiredEl)
		if (!editor) {
			throw new Error();
		}

		editor.focus();
		if (newCellCallback) {
			newCellCallback(editor.editorView);
		}

		return true;
	}

	static genShiftByOnConditionHandler(view: EditorView, tableElement: HTMLTableElement, editor: ObsidianEditorAdapter, shiftBy: () => number, condition: (target: EditorView) => boolean, newCellCallback: ((newEditor: EditorView) => void) | undefined = undefined): Command {
		return (target: EditorView) => {
			if (condition(target)) {
				if (this.tryShiftFromBy(view, tableElement, editor, shiftBy(), newCellCallback)) {
					return true;
				}
			}

			return false;
		}
	}

	static constructCell(view: EditorView, tableElement: HTMLTableElement, file: TFile): [HTMLTableCellElement, ObsidianEditorAdapter] {
		const td = document.createElement("td");
		td.classList.add(EDITOR_TABLE_CELL_CLASS);

		const [editorStorage] = view.state.facet(nestedEditorsFacet);
		const [div, editor] = editorStorage.newEditor(() => [
			Prec.highest(
				keymap.of([
					{
						key: 'Tab',
						run: this.genTabHandler(false, editor, view, tableElement, file),
						shift: this.genTabHandler(true, editor, view, tableElement, file),
						preventDefault: true,
					},
					{
						key: 'ArrowUp',
						run: (target) => {
							if (GridTableWidget.genShiftByOnConditionHandler(
							view,
							tableElement,
							editor,
							() => -TableAttributes.read(tableElement).cols,
							(cellEditor) => cellEditor.state.selection.main.head == 0,
							moveCursorToEnd,
							)(target)) {
								return true;
							}

							const cellAttrs = TableCellAttributes.read(editor.parentElement.parentElement);

							// If first row
							if (cellAttrs.row == 0) {
								// If cursor is at the beginning of the cell
								if (target.state.selection.main.head == 0) {
									const widgetPos = view.posAtDOM(tableElement);
									const posBeforeWidget = widgetPos - 1;
									view.focus();
									view.dispatch({
										selection: {
											head: posBeforeWidget,
											anchor: posBeforeWidget
										}
									})
									return true;
								}
							}
							return false;
						},
						preventDefault: true,
					},
					{
						key: 'ArrowDown',
						run: (target) => {
							if (GridTableWidget.genShiftByOnConditionHandler(
							view,
							tableElement,
							editor,
							() => TableAttributes.read(tableElement).cols,
							(cellEditor) => cellEditor.state.selection.main.head == cellEditor.state.doc.length,
							moveCursorToBeginning,
							)(target)) {
								return true;
							}

							const cellAttrs = TableCellAttributes.read(editor.parentElement.parentElement);
							const tableAttrs = TableAttributes.read(tableElement);

							// If last row
							if (cellAttrs.row == tableAttrs.rows - 1) {
								// If cursor is at the end of the cell
								if (target.state.selection.main.head == target.state.doc.length) {
									const widgetPos = view.posAtDOM(tableElement);
									const posAfterWidget = widgetPos + tableAttrs.sourceLength;
									view.focus();
									view.dispatch({
										selection: {
											head: posAfterWidget,
											anchor: posAfterWidget
										}
									})
									return true;
								}
							}
							return false;
						},
						preventDefault: true,
					},
					{
						key: 'ArrowLeft',
						run: GridTableWidget.genShiftByOnConditionHandler(
							view,
							tableElement,
							editor,
							() => -1,
							(cellEditor) =>
								cellEditor.state.selection.main.head == 0, // Start of cell
							moveCursorToEnd,
						),
						preventDefault: true,
					},
					{
						key: 'ArrowRight',
						run: GridTableWidget.genShiftByOnConditionHandler(
							view,
							tableElement,
							editor,
							() => 1,
							(cellEditor) =>
								cellEditor.state.selection.main.head == cellEditor.state.doc.length,
							moveCursorToBeginning,
						),
						preventDefault: true,
					},
				])
			),
			// Forward simple undo/redo out
			// TODO: Also hook into editor.undo()
			genKeyForwarder(view, ["Mod-z", "Mod-y"]),
		], file)
		editor.setChangeHandler((update) => {
			if (update.docChanged) {
				this.flushToFile(view, tableElement);
			}
		});

		td.appendChild(div);

		return [td, editor];
	}

	static addColumn(view: EditorView, tableElement: HTMLTableElement, file: TFile) {
		const trs = Array.from(tableElement.querySelectorAll(":scope > tr"));
		for (let i = 0; i < trs.length; i++) {
			const [td, editor] = this.constructCell(view, tableElement, file);
			editor.setContent("");
			trs[i].appendChild(td);
		}

		this.flushToFile(view, tableElement);
	}

	toDOM(view: EditorView): HTMLElement {
		this.loadEditors(view);
		const div = document.createElement("div");
		if (globalPlugin == null) {
			div.innerText = "Loading...";
			return div;
		}

		const plugin = globalPlugin;

		div.classList.add(EDITOR_TABLE_CONTAINER_CLASS);

		const table = document.createElement("table");
		table.classList.add(EDITOR_TABLE_CLASS);

		GridTableWidget.syncDomTableWithContent(view, table, this.contentToWriteToState, this.originalLength, this.file, plugin);

		div.appendChild(table);

		const newColButton = document.createElement("div");
		newColButton.innerHTML = PLUS_SVG;
		newColButton.classList.add(EDITOR_TABLE_ADD_COLUMN_BUTTON_CLASS);
		newColButton.classList.add(EDITOR_TABLE_BUTTON_CLASS);
		newColButton.addEventListener('click', (_) => {
			GridTableWidget.addColumn(view, table, this.file);
		})
		div.appendChild(newColButton);

		const newRowButton = document.createElement("div");
		newRowButton.innerHTML = PLUS_SVG;
		newRowButton.classList.add(EDITOR_TABLE_ADD_ROW_BUTTON_CLASS);
		newRowButton.classList.add(EDITOR_TABLE_BUTTON_CLASS);
		newRowButton.addEventListener('click', (_) => {
			GridTableWidget.addRow(view, table, this.file);
		})
		div.appendChild(newRowButton);

		return div;
	}

	static freeTD(editors: ObsidianEditorStorage, td: Element) {
		const editorContainer = td.querySelector(":scope > div");
		if (editorContainer) {
			const editor = editors.getEditorByElement(editorContainer);
			if (editor) {
				editors.delEditor(editor);
			}
		}
	}

	static syncDomTableDimensions(view: EditorView, tableEl: HTMLTableElement, file: TFile, desiredWidth: number, desiredHeight: number) {
		const rowElements = Array.from(tableEl.querySelectorAll(":scope > tr"));
		const [editors] = view.state.facet(nestedEditorsFacet);

		// Add missing rows
		for (let i = rowElements.length; i < desiredHeight; i++) {
			const newRow = this.genTrEl();
			tableEl.appendChild(newRow);
			rowElements.push(newRow);
		}

		// Trim excess rows
		if (rowElements.length > desiredHeight) {
			for (const excessTR of rowElements.slice(desiredHeight)) {
				for (const td of Array.from(excessTR.querySelectorAll(":scope > td"))) {
					this.freeTD(editors, td);
				}
				excessTR.remove();
			}
		}

		for (const rowEl of rowElements) {
			const cellElements = Array.from(rowEl.querySelectorAll(":scope > td"));

			// Add missing cells
			for (let i = cellElements.length; i < desiredWidth; i++) {
				const [newCell, editor] = this.constructCell(view, tableEl, file);
				editor.setContent("");
				rowEl.appendChild(newCell);
				cellElements.push(newCell);
			}

			// Trim excess cells
			for (const excessCell of cellElements.slice(desiredWidth)) {
				this.freeTD(editors, excessCell);
				excessCell.remove();
			}
		}
	}

	static syncDomTableWithContent(view: EditorView, tableEl: HTMLTableElement, content: TableContent, sourceLength: number, file: TFile, plugin: Plugin) {
		const [editors] = view.state.facet(nestedEditorsFacet);

		this.syncDomTableDimensions(view, tableEl, file, content.columnCount, content.rowCount);
		const rowElements = Array.from(tableEl.querySelectorAll(":scope > tr"));


		for (const [rowIdx, row] of enumerate(content.rows)) {
			const rowEl = rowElements[rowIdx];
			const tds: HTMLTableCellElement[] = Array.from(rowEl.querySelectorAll(":scope > td"));
			for (const [colIdx, col] of enumerate(row.cells)) {
				const colEl = tds[colIdx];
				const editorContainer = colEl.querySelector(':scope > div');
				if (editorContainer == undefined) {
					console.error(colEl);
					throw new Error("No editor container for td in table");
				}
				const editor = editors.getEditorByElement(editorContainer);
				if (editor == undefined) {
					console.error(editorContainer);
					throw new Error("No editor for container");
				}
				const cellContent = col.content;
				const changeHandler = editor.getChangeHandler();
				editor.setChangeHandler(undefined);
				if (trimLines(cellContent).trim() != trimLines(editor.getContent()).trim()) {
					editor.setContent(cellContent);
				}
				editor.setChangeHandler(changeHandler);

				colEl.style.width = suggestWidth(colEl.querySelector(".cm-contentContainer").innerText, ".", colEl);

				new TableCellAttributes(colIdx, rowIdx, colIdx + rowIdx * content.columnCount).write(colEl);
			}
		}

		new TableAttributes(sourceLength, content.columnCount, content.rowCount).write(tableEl);
	}

	static tableContentFromDOM(view: EditorView, tableElement: HTMLTableElement) {
		const rows = [];
		const [editors] = view.state.facet(nestedEditorsFacet);
		for (const tr of Array.from(tableElement.querySelectorAll(":scope > tr"))) {
			const cells = [];
			for (const td of Array.from(tr.querySelectorAll(":scope > td"))) {
				const containingDiv = td.querySelector(":scope > div");
				if (containingDiv == null) {
					throw new Error();
				}

				const editor = editors.getEditorByElement(containingDiv);
				if (!editor) {
					throw new Error();
				}

				const content = editor.getContent()
				cells.push(new TableCell(content));
			}
			rows.push(new TableRow(cells));
		}
		return new TableContent(rows);
	}

	static flushToFile(view: EditorView, tableElement: HTMLTableElement) {
		const from = view.posAtDOM(tableElement);
		const currentContentLength = TableAttributes.read(tableElement).sourceLength;
		const to = from + currentContentLength;
		const newTable = this.tableContentFromDOM(view, tableElement);
		const newTableRepr = tableContentToString(newTable) + "\n";

		view.dispatch({
			changes: { from: from, to: to, insert: newTableRepr }
		})
	}

	destroy(dom: HTMLElement): void {
		const table = dom.querySelector(":scope > table");
		if (!table) return;

		for (const tr of Array.from(table.querySelectorAll(":scope > tr"))) {
			for (const td of Array.from(tr.querySelectorAll(":scope > td > div"))) {
				const editor = this.editorStorage.getEditorByElement(td);
				if (editor) {
					this.editorStorage.delEditor(editor);
				}
			}
		}
	}
}

function* accessIterator<T>(whole: (index: number) => T, startIndex: number, maxIndex: number) {
	for (let index = startIndex; index < maxIndex; index++) {
		yield whole(index);
	}
}

const tableField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none
	},
	update(oldState: DecorationSet, tr: Transaction): DecorationSet {
		const mdInfo = tr.state.field(editorInfoField);
		const fileRef = mdInfo.file;

		const view = tr.state.field(editorEditorField);
		const livePreview = view.state.field(editorLivePreviewField);
		const isSourceMode = !livePreview;

		const builder = new RangeSetBuilder<Decoration>();
		let index = 1;
		const potentialTables = [];
		let scannedUpTo = 0;
		const lines = [""];
		for (const line of tr.state.doc.iterLines()) {
			lines.push(line);
			try {
				SeparatorLine.tryParse(line);
				potentialTables.push(index);
			} catch (e) {
				// Line wasn't a separator line, so it isn't the start of a potential table.
			}
			index++;
		}

		for (const tableStartLine of potentialTables) {

			// If range is already part of previous table.
			if (tableStartLine <= scannedUpTo) {
				continue;
			}

			const parts = lookAheadForTableParts(
				accessIterator(
					(index) => lines[index],
					tableStartLine,
					lines.length
				)
			);

			let table: TableContent | null = null;

			try {
				table = tryParseTableFromParsedParts(parts);
			} catch (e) {
				// Failed to parse table.
				continue;
			}

			const tableEndLine = tableStartLine + parts.length - 1;
			const from = tr.state.doc.line(tableStartLine).from;
			const to = tr.state.doc.line(tableEndLine).to + 1;

			if (isSourceMode) {
				builder.add(from, to, Decoration.mark({ class: 'HyperMD-table-row' }))
			} else {
				if (!fileRef) {
					throw new Error("No fileRef!");
				}
				builder.add(from, to, Decoration.replace({
					widget: new GridTableWidget(table, fileRef, to - from)
				}));
			}

			scannedUpTo = tableEndLine;
		}

		return builder.finish();
	},
	provide(field: StateField<DecorationSet>): Extension {
		return EditorView.decorations.from(field);
	},
});

function renderTablesInMarkdown(element: HTMLElement, context: MarkdownPostProcessorContext): void {
	if (globalPlugin == null) return;

	const paragraphs = element.findAll("p");
	for (const p of paragraphs) {
		const originalText = context.getSectionInfo(p);
		if (originalText == null) continue;

		const text = originalText.text.split("\n").slice(originalText.lineStart - 1, originalText.lineEnd + 1).join("\n").trimStart();

		const parts = lookAheadForTableParts(text.split("\n"));
		let table = null;
		try {
			table = tryParseTableFromParsedParts(parts)
		} catch (e) {
			// No table.
			continue;
		}

		const tableEl = document.createElement("table");
		for (const row of table.rows) {
			const tr = document.createElement("tr");
			for (const cell of row.cells) {
				const td = document.createElement("td");
				MarkdownRenderer.render(globalPlugin.app, cell.content, td, context.sourcePath, globalPlugin)
				tr.appendChild(td);
			}
			tableEl.appendChild(tr);
		}

		const leftoverText = text.split("\n").slice(parts.length).join("\n");
		const leftover = document.createElement("div");
		MarkdownRenderer.render(globalPlugin.app, leftoverText, leftover, context.sourcePath, globalPlugin);
		p.replaceWith(tableEl);
		for (const child of Array.from(leftover.children)) {
			tableEl.parentElement?.appendChild(child);
		}
	}
}

let globalPlugin: GridTablePlugin | null = null;

export default class GridTablePlugin extends Plugin {
	settings: GridTablePluginSettings;

	async onload() {
		globalPlugin = this;
		await this.loadSettings();
		this.registerEditorExtension(nestedEditorsFacet.of(new ObsidianEditorStorage(this)))
		this.registerEditorExtension(tableField);
		this.app.workspace.getActiveViewOfType(MarkdownView)
		this.registerEditorExtension(Prec.lowest(
			EditorView.focusChangeEffect.of((state, focusing) => {
				if (focusing) {
					const mdInfo = state.field(editorInfoField);
					if (mdInfo.nestedMdController == undefined) {
						this.app.workspace._activeEditor = null; // mdInfo;
					}
				}

				return null;
			}),
		))
		this.addCommand({
			id: 'sample-command',
			name: "Sample Command",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const sel = editor.getSelection();

				console.log(sel);
			}
		});
		this.registerMarkdownPostProcessor(renderTablesInMarkdown)


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
	plugin: GridTablePlugin;

	constructor(app: App, plugin: GridTablePlugin) {
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
