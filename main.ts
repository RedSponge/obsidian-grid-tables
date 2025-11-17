import { App, Editor, editorEditorField, editorInfoField, editorLivePreviewField, MarkdownPostProcessorContext, MarkdownRenderer, MarkdownView, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { Extension, Facet, Prec, RangeSetBuilder, StateField, Transaction } from "@codemirror/state"
import { Command, Decoration, DecorationSet, EditorView, keymap, WidgetType } from '@codemirror/view'
import { lookAheadForTableParts, SeparatorLine, tableContentToString, tryParseTableFromParsedParts } from 'src/TableSerde';
import { TableCell, TableContent, TableRow } from 'src/TableData';
import { ObsidianEditorAdapter } from 'src/ObsidianEditorAdapter';
import { EDITOR_TABLE_ADD_COLUMN_BUTTON_CLASS, EDITOR_TABLE_ADD_ROW_BUTTON_CLASS, EDITOR_TABLE_BUTTON_CLASS, EDITOR_TABLE_CELL_CLASS, EDITOR_TABLE_CLASS, EDITOR_TABLE_CONTAINER_CLASS, EDITOR_TABLE_RESIZE_HANDLE_CLASS, EDITOR_TABLE_ROW_CLASS, PLUS_SVG } from 'src/consts';
import { BiMap } from 'src/BiMap';

// Remember to rename these classes and interfaces!

function trimLines(str: string): string {
	return str.split("\n").map((s) => s.trim()).join("\n");
}

interface GridTablePluginSettings {
	mySetting: string;
	// When enabled, column widths are treated as opinionated visual widths and
	// are stored as numeric hints alongside separator lines. This allows
	// columns to be visually narrower than their longest line while keeping the
	// underlying ASCII grid structurally valid.
	opinionatedSizes: boolean;
}

const DEFAULT_SETTINGS: GridTablePluginSettings = {
	mySetting: 'default',
	opinionatedSizes: false,
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

	newEditor(extensions: () => Extension[], file: TFile, parentEditor: EditorView | null = null): [Element, ObsidianEditorAdapter] {
		const editor = new ObsidianEditorAdapter(this.plugin);
		editor.setExtraExtensionProvider(extensions)

		const containingElement = document.createElement("div");
		editor.mount(containingElement, file)

		if (!editor.activeEditor) {
			throw new Error("Just mounted the editor!");
		}
		editor.activeEditor.parentEditor = parentEditor;

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
	static readonly ATTRIBUTE_COL_WIDTHS = "col-widths";

	sourceLength: number
	cols: number
	rows: number
	colWidths: number[] | null

	constructor(sourceLength: number, cols: number, rows: number, colWidths: number[] | null = null) {
		this.sourceLength = sourceLength;
		this.cols = cols;
		this.rows = rows;
		this.colWidths = colWidths;
	}

	write(el: Element) {
		el.setAttribute(TableAttributes.ATTRIBUTE_SOURCE_LENGTH, this.sourceLength.toString());
		el.setAttribute(TableAttributes.ATTRIBUTE_COLS, this.cols.toString());
		el.setAttribute(TableAttributes.ATTRIBUTE_ROWS, this.rows.toString());

		if (this.colWidths && this.colWidths.length > 0) {
			el.setAttribute(TableAttributes.ATTRIBUTE_COL_WIDTHS, this.colWidths.join(","));
		} else {
			el.removeAttribute(TableAttributes.ATTRIBUTE_COL_WIDTHS);
		}
	}

	static read(el: Element): TableAttributes {
		const sourceLength = parseInt(getAttrOrErr(el, TableAttributes.ATTRIBUTE_SOURCE_LENGTH));
		const cols = parseInt(getAttrOrErr(el, TableAttributes.ATTRIBUTE_COLS));
		const rows = parseInt(getAttrOrErr(el, TableAttributes.ATTRIBUTE_ROWS));

		const widthsAttr = el.getAttr(TableAttributes.ATTRIBUTE_COL_WIDTHS);
		let colWidths: number[] | null = null;
		if (widthsAttr) {
			const parts = widthsAttr.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n) && n > 0);
			if (parts.length > 0) {
				colWidths = parts;
			}
		}

		return new TableAttributes(sourceLength, cols, rows, colWidths);
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


const nestedEditorsFacet = Facet.define<ObsidianEditorStorage>();

class TableCommands {
	static addRowBelow(tdEl: HTMLTableCellElement, editor: EditorView, file: TFile) {
		const tableElement = tdEl.parentElement?.parentElement as HTMLTableElement;
		if (!tableElement) throw new Error();

		const cellAttributes = TableCellAttributes.read(tdEl);
		GridTableWidget.addRowAfter(editor, tableElement, file, cellAttributes.row);
	}

	static addRowAbove(tdEl: HTMLTableCellElement, editor: EditorView, file: TFile) {
		const tableElement = tdEl.parentElement?.parentElement as HTMLTableElement;
		if (!tableElement) throw new Error();

		const cellAttributes = TableCellAttributes.read(tdEl);
		GridTableWidget.addRowAfter(editor, tableElement, file, cellAttributes.row - 1);
	}

	static addColumnAfter(tdEl: HTMLTableCellElement, editor: EditorView, file: TFile) {
		const tableElement = tdEl.parentElement?.parentElement as HTMLTableElement;
		if (!tableElement) throw new Error();

		const cellAttributes = TableCellAttributes.read(tdEl);
		GridTableWidget.addColumnAt(editor, tableElement, file, cellAttributes.col + 1);
	}

	static addColumnBefore(tdEl: HTMLTableCellElement, editor: EditorView, file: TFile) {
		const tableElement = tdEl.parentElement?.parentElement as HTMLTableElement;
		if (!tableElement) throw new Error();

		const cellAttributes = TableCellAttributes.read(tdEl);
		GridTableWidget.addColumnAt(editor, tableElement, file, cellAttributes.col);
	}

	static deleteRowAt(tdEl: HTMLTableCellElement, editor: EditorView) {
		const tableElement = tdEl.parentElement?.parentElement as HTMLTableElement;
		if (!tableElement) throw new Error();

		const cellAttributes = TableCellAttributes.read(tdEl);
		GridTableWidget.deleteRow(editor, tableElement, cellAttributes.row);
	}

	static deleteColumnAt(tdEl: HTMLTableCellElement, editor: EditorView) {
		const tableElement = tdEl.parentElement?.parentElement as HTMLTableElement;
		if (!tableElement) throw new Error();

		const cellAttributes = TableCellAttributes.read(tdEl);
		GridTableWidget.deleteColumn(editor, tableElement, cellAttributes.col);
	}

	static shiftRowUp(tdEl: HTMLTableCellElement, editor: EditorView) {
		const tableElement = tdEl.parentElement?.parentElement as HTMLTableElement;
		if (!tableElement) throw new Error();

		const cellAttributes = TableCellAttributes.read(tdEl);
		GridTableWidget.moveRow(editor, tableElement, cellAttributes.row, cellAttributes.row - 1);
	}

	static shiftRowDown(tdEl: HTMLTableCellElement, editor: EditorView) {
		const tableElement = tdEl.parentElement?.parentElement as HTMLTableElement;
		if (!tableElement) throw new Error();

		const cellAttributes = TableCellAttributes.read(tdEl);
		GridTableWidget.moveRow(editor, tableElement, cellAttributes.row, cellAttributes.row + 1);
	}

	static shiftColumnRight(tdEl: HTMLTableCellElement, editor: EditorView) {
		const tableElement = tdEl.parentElement?.parentElement as HTMLTableElement;
		if (!tableElement) throw new Error();

		const cellAttributes = TableCellAttributes.read(tdEl);
		GridTableWidget.moveColumn(editor, tableElement, cellAttributes.col, cellAttributes.col + 1);
	}

	static shiftColumnLeft(tdEl: HTMLTableCellElement, editor: EditorView) {
		const tableElement = tdEl.parentElement?.parentElement as HTMLTableElement;
		if (!tableElement) throw new Error();

		const cellAttributes = TableCellAttributes.read(tdEl);
		GridTableWidget.moveColumn(editor, tableElement, cellAttributes.col, cellAttributes.col - 1);
	}

	static deleteTable(tableEl: HTMLTableElement, editor: EditorView) {
		GridTableWidget.deleteTable(editor, tableEl);
	}
}

export class GridTableWidget extends WidgetType {
	static uids: number

	readonly contentToWriteToState: TableContent
	readonly originalLength: number
	readonly baseSeparatorWidths: number[] | null
	readonly initialVisualWidths: number[] | null

	file: TFile
	uid: number
	editorStorage: ObsidianEditorStorage

	constructor(
		contentToWriteToState: TableContent,
		file: TFile,
		originalLength: number,
		baseSeparatorWidths: number[] | null = null,
		initialVisualWidths: number[] | null = null,
	) {
		super()
		this.contentToWriteToState = contentToWriteToState;
		this.file = file;
		this.originalLength = originalLength;
		this.baseSeparatorWidths = baseSeparatorWidths ? baseSeparatorWidths.slice() : null;
		this.initialVisualWidths = initialVisualWidths ? initialVisualWidths.slice() : null;

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
		if (!GridTablePlugin.instance) return false;

		GridTableWidget.syncDomTableWithContent(
			view,
			tableEl as HTMLTableElement,
			this.contentToWriteToState,
			this.originalLength,
			this.file,
			GridTablePlugin.instance,
			this.baseSeparatorWidths ?? undefined,
			this.initialVisualWidths ?? undefined,
		);

		return true;
	}

	static getAttsOfEditor(editor: ObsidianEditorAdapter): TableCellAttributes {
		if (!editor.parentElement.parentElement) {
			throw new Error();
		}

		return TableCellAttributes.read(editor.parentElement.parentElement);
	}

	static getIndexOfEditor(editor: ObsidianEditorAdapter): number {
		return this.getAttsOfEditor(editor).tabIndex;
	}

	static deleteTable(view: EditorView, tableElement: HTMLTableElement) {
		const tablePos = view.posAtDOM(tableElement);

		// Simply write '' over the table contents and let the widget cleanup take care of the rest.
		this.writeOverTable(view, tableElement, '');

		view.focus();
		view.dispatch({
			selection: {
				head: tablePos,
				anchor: tablePos,
			}
		})
	}

	static deleteRow(view: EditorView, tableElement: HTMLTableElement, rowIndex: number) {
		const tr = tableElement.querySelector(`:scope > tr:nth-child(${rowIndex + 1})`)
		if (!tr) return;

		const [editorStorage] = view.state.facet(nestedEditorsFacet);
		const tableAttrs = TableAttributes.read(tableElement);

		if (tableAttrs.rows == 1) {
			this.deleteTable(view, tableElement);
			return;
		}

		let currentFocus: TableCellAttributes | null = null;

		for (const td of Array.from(tr.querySelectorAll(":scope > td"))) {
			const editor = editorStorage.getEditorByElement(td.children[0]);

			if (!editor?.activeEditor) {
				continue;
			}

			if (editor.activeEditor.editorEl.contains(document.activeElement)) {
				currentFocus = TableCellAttributes.read(td)
			}

			if (editor) {
				editorStorage.delEditor(editor);
			}
		}

		if (currentFocus) {
			const newFocusCol = currentFocus.col;
			let newFocusRow;

			// Focus should go to the next row unless there isn't any
			// (next row is 'sliding into' where deleted row was).
			if (currentFocus.row == tableAttrs.rows - 1) {
				newFocusRow = currentFocus.row - 1;
			} else {
				newFocusRow = currentFocus.row + 1;
			}

			const newFocus = this.getCellAt(tableElement, newFocusCol, newFocusRow)
			if (newFocus) {
				editorStorage.getEditorByElement(newFocus?.children[0])?.focus();
			}
		}

		tr.remove();

		this.flushDomToFile(view, tableElement)
	}

	static getCellAt(tableElement: HTMLTableElement, col: number, row: number) {
		return tableElement.querySelector(`:scope > tr > td[col="${col}"][row="${row}"]`)
	}

	static deleteColumn(view: EditorView, tableElement: HTMLTableElement, colIndex: number) {
		const trs = Array.from(tableElement.querySelectorAll(`:scope > tr`))
		const [editorStorage] = view.state.facet(nestedEditorsFacet);

		const tableAttrs = TableAttributes.read(tableElement);

		if (tableAttrs.cols == 1) {
			this.deleteTable(view, tableElement);
			return;
		}

		let currentFocus: TableCellAttributes | null = null;
		for (const tr of trs) {
			const td = tr.querySelector(`:scope > td:nth-child(${colIndex + 1})`);

			if (!td) continue;

			const editor = editorStorage.getEditorByElement(td.children[0]);

			if (editor && editor.activeEditor) {
				if (editor.activeEditor.editorEl.contains(document.activeElement)) {
					currentFocus = TableCellAttributes.read(td)
				}
				editorStorage.delEditor(editor);
			}

			td.remove();
		}

		if (currentFocus) {
			const newFocusRow = currentFocus.row;
			let newFocusCol;

			// Focus should go to the next col unless there isn't any
			// (next col is 'sliding into' where deleted col was).
			if (currentFocus.col == tableAttrs.cols - 1) {
				newFocusCol = currentFocus.col - 1;
			} else {
				newFocusCol = currentFocus.col + 1;
			}

			const newFocus = this.getCellAt(tableElement, newFocusCol, newFocusRow)
			if (newFocus) {
				editorStorage.getEditorByElement(newFocus?.children[0])?.focus();
			}
		}

		this.flushDomToFile(view, tableElement)
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
					this.addRowAfter(view, containingTable, file, null);
					// Try shifting now that new cell was created.
					this.tryShiftFromBy(view, containingTable, editor, 1);
				} else {
					console.warn("Doing nothing!");
				}
			}

			return true;
		}
	}

	static addRowAfter(view: EditorView, containingTable: HTMLTableElement, file: TFile, rowIndex: number | null) {
		const newRow = new TableRow(Array.from({ length: TableAttributes.read(containingTable).cols }, () => new TableCell("")));
		const newTR = this.constructRow(newRow, view, containingTable, file);
		containingTable.insertBefore(newTR, rowIndex === null ? rowIndex : containingTable.children[rowIndex + 1]);
		this.flushDomToFile(view, containingTable);
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

							const cellAttrs = this.getAttsOfEditor(editor);

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

							const cellAttrs = this.getAttsOfEditor(editor);
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
		], file, view)
		editor.setChangeHandler((update) => {
			if (update.docChanged) {
				this.flushDomToFile(view, tableElement);
			}
		});

		td.appendChild(div);

		return [td, editor];
	}

	static addColumnAt(view: EditorView, tableElement: HTMLTableElement, file: TFile, columnIndex: number | null) {
		const trs = Array.from(tableElement.querySelectorAll(":scope > tr"));
		for (let i = 0; i < trs.length; i++) {
			const [td, editor] = this.constructCell(view, tableElement, file);
			editor.setContent("");
			trs[i].insertBefore(td, columnIndex == null ? columnIndex : trs[i].children[columnIndex]);
		}

		this.flushDomToFile(view, tableElement);
	}

	static moveColumn(view: EditorView, tableElement: HTMLTableElement, fromIndex: number, toIndex: number) {
		const tableAttrs = TableAttributes.read(tableElement);
		const [editorStorage] = view.state.facet(nestedEditorsFacet);

		if (fromIndex < 0 || fromIndex >= tableAttrs.cols || toIndex < 0 || toIndex >= tableAttrs.cols || fromIndex == toIndex) return;

		let focusedEditor = null;

		for (const tr of Array.from(tableElement.querySelectorAll(":scope > tr"))) {
			const tdToMove = tr.querySelector(`:scope > td:nth-child(${fromIndex + 1})`);
			if (!tdToMove) continue;

			if (tdToMove.contains(document.activeElement)) {
				const editor = editorStorage.getEditorByElement(tdToMove.children[0]);
				if (!editor) throw new Error();

				focusedEditor = editor;
			}

			tdToMove.remove();
			const tdToPutAfter = tr.querySelector(`:scope > td:nth-child(${toIndex})`)
			tr.insertAfter(tdToMove, tdToPutAfter);

		}

		focusedEditor?.focus();

		this.flushDomToFile(view, tableElement);
	}

	static moveRow(view: EditorView, tableElement: HTMLTableElement, fromIndex: number, toIndex: number) {
		const tableAttrs = TableAttributes.read(tableElement);
		const [editorStorage] = view.state.facet(nestedEditorsFacet);

		if (fromIndex < 0 || fromIndex >= tableAttrs.rows || toIndex < 0 || toIndex >= tableAttrs.rows || fromIndex == toIndex) return;
		const trToMove = tableElement.querySelector(`:scope > tr:nth-child(${fromIndex + 1})`);
		if (!trToMove) return;

		let focusedEditor = null;

		for (const td of Array.from(trToMove.querySelectorAll(":scope > td"))) {
			const editor = editorStorage.getEditorByElement(td.children[0]);
			if (!editor) throw new Error();

			if (td.contains(document.activeElement)) {
				focusedEditor = editor;
				break;
			}
		}

		trToMove?.remove()

		const trToPutAfter = tableElement.querySelector(`:scope > tr:nth-child(${toIndex})`);
		tableElement.insertAfter(trToMove, trToPutAfter);

		focusedEditor?.focus();
		this.flushDomToFile(view, tableElement);
	}

	toDOM(view: EditorView): HTMLElement {
		this.loadEditors(view);
		const div = document.createElement("div");
		if (GridTablePlugin.instance == null) {
			div.innerText = "Loading...";
			return div;
		}

		const plugin = GridTablePlugin.instance;

		div.classList.add(EDITOR_TABLE_CONTAINER_CLASS);

		const table = document.createElement("table");
		table.classList.add(EDITOR_TABLE_CLASS);

		GridTableWidget.syncDomTableWithContent(
			view,
			table,
			this.contentToWriteToState,
			this.originalLength,
			this.file,
			plugin,
			this.baseSeparatorWidths ?? undefined,
			this.initialVisualWidths ?? undefined,
		);

		div.appendChild(table);

		const newColButton = document.createElement("div");
		newColButton.innerHTML = PLUS_SVG;
		newColButton.classList.add(EDITOR_TABLE_ADD_COLUMN_BUTTON_CLASS);
		newColButton.classList.add(EDITOR_TABLE_BUTTON_CLASS);
		newColButton.addEventListener('click', (_) => {
			GridTableWidget.addColumnAt(view, table, this.file, null);
		})
		div.appendChild(newColButton);

		const newRowButton = document.createElement("div");
		newRowButton.innerHTML = PLUS_SVG;
		newRowButton.classList.add(EDITOR_TABLE_ADD_ROW_BUTTON_CLASS);
		newRowButton.classList.add(EDITOR_TABLE_BUTTON_CLASS);
		newRowButton.addEventListener('click', (_) => {
			GridTableWidget.addRowAfter(view, table, this.file, null);
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

	static syncDomTableWithContent(
		view: EditorView,
		tableEl: HTMLTableElement,
		content: TableContent,
		sourceLength: number,
		file: TFile,
		plugin: Plugin,
		baseSeparatorWidths?: number[],
		initialVisualWidths?: number[],
	) {
		const [editors] = view.state.facet(nestedEditorsFacet);

		this.syncDomTableDimensions(view, tableEl, file, content.columnCount, content.rowCount);
		const rowElements = Array.from(tableEl.querySelectorAll(":scope > tr"));

		// Compute logical separator widths per column, derived from either the base
		// widths (coming from the parsed separator line) or from the content.
		const colContentWidths: number[] = [];
		for (const row of content.rows) {
			for (let colIdx = 0; colIdx < row.cells.length; colIdx++) {
				if (colContentWidths.length <= colIdx) {
					colContentWidths.push(0);
				}
				const lines = row.cells[colIdx].content.split(/\n/);
				const maxLen = Math.max(...lines.map((l) => l.length));
				if (maxLen > colContentWidths[colIdx]) {
					colContentWidths[colIdx] = maxLen;
				}
			}
		}

		const separatorWidths: number[] = [];
		for (let colIdx = 0; colIdx < colContentWidths.length; colIdx++) {
			const contentWidth = colContentWidths[colIdx] || 0;
			let sepWidth = baseSeparatorWidths && baseSeparatorWidths[colIdx] ? baseSeparatorWidths[colIdx] : 0;

			if (sepWidth <= 0) {
				sepWidth = contentWidth === 0 ? 1 : contentWidth + 2;
			} else if (contentWidth > sepWidth) {
				sepWidth = contentWidth;
			}

			separatorWidths.push(sepWidth);
		}

		// Determine visual widths. When opinionatedSizes is enabled, these are the
		// independent visual widths we persist and later encode as numeric hints
		// alongside separator lines. Otherwise, they simply mirror the structural
		// widths and are stored as the structural defaults.
		const pluginInstance = GridTablePlugin.instance;
		const useOpinionated = pluginInstance?.settings.opinionatedSizes === true;
		const existingAttrs = tableEl.hasAttribute(TableAttributes.ATTRIBUTE_SOURCE_LENGTH)
			? TableAttributes.read(tableEl)
			: null;

		const visualWidths: number[] = [];
		for (let colIdx = 0; colIdx < separatorWidths.length; colIdx++) {
			let visualWidth: number;
			if (useOpinionated) {
				if (existingAttrs && existingAttrs.colWidths && existingAttrs.colWidths[colIdx] != null) {
					visualWidth = existingAttrs.colWidths[colIdx];
				} else if (initialVisualWidths && initialVisualWidths[colIdx] != null && initialVisualWidths[colIdx] > 0) {
					// First render in opinionated mode: respect visual hints encoded in the separator.
					visualWidth = initialVisualWidths[colIdx];
				} else {
					visualWidth = separatorWidths[colIdx];
				}
			} else {
				// Non-opinionated mode: no separate visual notion; mirror structure.
				visualWidth = separatorWidths[colIdx];
			}
			if (visualWidth < 1) visualWidth = 1;
			visualWidths.push(visualWidth);
		}

		for (const [rowIdx, row] of enumerate(content.rows)) {
			const rowEl = rowElements[rowIdx];
			const tds: HTMLTableCellElement[] = Array.from(rowEl.querySelectorAll(":scope > td"));
			for (const [colIdx, col] of enumerate(row.cells)) {
				const colEl = tds[colIdx];
				const editorContainer = colEl.querySelector(":scope > div");
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

				const widthValue = visualWidths[colIdx] || separatorWidths[colIdx] || 1;
				const cssWidth = Math.max(widthValue, 1);
				// In opinionated mode, numeric hints represent pixels. Otherwise, they
				// represent approximate character widths.
				colEl.style.width = useOpinionated ? `${cssWidth}px` : `${cssWidth}ch`;

				new TableCellAttributes(colIdx, rowIdx, colIdx + rowIdx * content.columnCount).write(colEl);

				// Add a resize handle only for the first row's cells so we get a single
				// handle per column.
				if (rowIdx === 0) {
					// Remove any existing handles to avoid stacking multiples when the widget re-renders.
					for (const existing of Array.from(colEl.getElementsByClassName(EDITOR_TABLE_RESIZE_HANDLE_CLASS))) {
						existing.remove();
					}

					const handle = document.createElement("div");
					handle.classList.add(EDITOR_TABLE_RESIZE_HANDLE_CLASS);
					const pluginInst = GridTablePlugin.instance;
					if (pluginInst) {
						pluginInst.registerDomEvent(handle, "pointerdown", (event: Event) => {
							const pointerEvent = event as PointerEvent;
							pointerEvent.preventDefault();
							pointerEvent.stopPropagation();
							GridTableWidget.startColumnResize(view, tableEl, colIdx, widthValue, pointerEvent);
						});
					} else {
						handle.addEventListener("pointerdown", (event: PointerEvent) => {
							event.preventDefault();
							event.stopPropagation();
							GridTableWidget.startColumnResize(view, tableEl, colIdx, widthValue, event);
						});
					}
					colEl.appendChild(handle);
				}
			}
		}

		// Persist column widths. In opinionated mode, these are independent visual
		// widths. In non-opinionated mode, they are the structural defaults used as
		// base separator widths on the next serialization.
		const widthsToPersist = useOpinionated ? visualWidths : separatorWidths;
		new TableAttributes(sourceLength, content.columnCount, content.rowCount, widthsToPersist).write(tableEl);
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

	static flushDomToFile(view: EditorView, tableElement: HTMLTableElement) {
		const newTable = this.tableContentFromDOM(view, tableElement);
		const tableAttrs = TableAttributes.read(tableElement);
		const pluginInstance = GridTablePlugin.instance;
		const useOpinionated = pluginInstance?.settings.opinionatedSizes === true;
		let newTableRepr: string;
		if (useOpinionated) {
			const visualWidths = tableAttrs.colWidths ?? undefined;
			// Structural separator widths are always derived from content; visualWidths
			// (when provided) are encoded as numeric hints alongside the separators.
			newTableRepr = tableContentToString(newTable, undefined, visualWidths);
		} else {
			const baseWidths = tableAttrs.colWidths ?? undefined;
			newTableRepr = tableContentToString(newTable, baseWidths);
		}

		this.writeOverTable(view, tableElement, newTableRepr);
	}

	static writeOverTable(view: EditorView, tableElement: HTMLTableElement, newContent: string) {
		const from = view.posAtDOM(tableElement);
		const currentContentLength = TableAttributes.read(tableElement).sourceLength;
		const to = from + currentContentLength;

		view.dispatch({
			changes: { from: from, to: to, insert: newContent }
		})
	}

	static startColumnResize(
		view: EditorView,
		tableElement: HTMLTableElement,
		colIndex: number,
		initialWidth: number,
		startEvent: PointerEvent,
	) {
		const attrs = TableAttributes.read(tableElement);
		const currentWidths: number[] = attrs.colWidths ? attrs.colWidths.slice() : [];
		const pluginInstance = GridTablePlugin.instance;
		const useOpinionated = pluginInstance?.settings.opinionatedSizes === true;

		while (currentWidths.length <= colIndex) {
			currentWidths.push(initialWidth);
		}

		const firstCell = tableElement.querySelector(`:scope > tr > td[col="${colIndex}"]`) as HTMLTableCellElement | null;
		if (!firstCell) return;

		const rect = firstCell.getBoundingClientRect();
		const startX = startEvent.clientX;

		let basePixelWidth = rect.width || 1;
		let baseCharWidth = currentWidths[colIndex] || initialWidth || 1;
		if (useOpinionated) {
			// In opinionated mode, widths are stored as pixels.
			basePixelWidth = currentWidths[colIndex] || rect.width || 1;
		} else {
			// In non-opinionated mode, widths are character-based.
			baseCharWidth = currentWidths[colIndex] || initialWidth || 1;
		}

		const pixelsPerChar = basePixelWidth / Math.max(baseCharWidth, 1);

		const onMove = (e: PointerEvent) => {
			const deltaPx = e.clientX - startX;
			let newWidth: number;
			if (useOpinionated) {
				// Pixel-based resizing.
				newWidth = basePixelWidth + deltaPx;
			} else {
				// Character-based resizing.
				const deltaChars = Math.round(deltaPx / Math.max(pixelsPerChar, 1));
				newWidth = baseCharWidth + deltaChars;
			}
			if (newWidth < 1) newWidth = 1;

			currentWidths[colIndex] = newWidth;
			const updatedAttrs = new TableAttributes(attrs.sourceLength, attrs.cols, attrs.rows, currentWidths);
			updatedAttrs.write(tableElement);

			const cssWidth = Math.max(newWidth, 1);
			for (const cell of Array.from(tableElement.querySelectorAll(`:scope > tr > td[col="${colIndex}"]`)) as HTMLTableCellElement[]) {
				(cell as HTMLTableCellElement).style.width = useOpinionated ? `${cssWidth}px` : `${cssWidth}ch`;
			}
		};

		const onUpOrCancel = (e: PointerEvent) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUpOrCancel);
			window.removeEventListener("pointercancel", onUpOrCancel);
			GridTableWidget.flushDomToFile(view, tableElement);
		};

		// These listeners are short-lived (per resize gesture) and are removed
		// explicitly in onUpOrCancel, so we attach them directly to window.
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUpOrCancel);
		window.addEventListener("pointercancel", onUpOrCancel);
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
			const to = tr.state.doc.line(tableEndLine).to;

			if (isSourceMode) {
				builder.add(from, to, Decoration.mark({ class: 'obsidian-grid-tables-table-source' }))
			} else {
				if (!fileRef) {
					throw new Error("No fileRef!");
				}
				let baseWidths: number[] | null = null;
				let visualWidths: number[] | null = null;
				if (parts.length > 0 && parts[0] instanceof SeparatorLine) {
					const sep = parts[0] as SeparatorLine;
					baseWidths = sep.columnLengths.slice();
					if (sep.visualWidths && sep.visualWidths.length > 0) {
						visualWidths = sep.visualWidths.slice();
					}
				}
				builder.add(from, to, Decoration.replace({
					widget: new GridTableWidget(table, fileRef, to - from, baseWidths, visualWidths),
					block: true,
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
	const plugin = GridTablePlugin.instance;
	if (plugin == null) return;

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

		// Derive visual column widths from the first separator line, if present.
		let separatorWidths: number[] | null = null;
		let visualWidths: number[] | null = null;
		if (parts.length > 0 && parts[0] instanceof SeparatorLine) {
			const sep = parts[0] as SeparatorLine;
			separatorWidths = sep.columnLengths.slice();
			if (plugin.settings.opinionatedSizes && sep.visualWidths && sep.visualWidths.length > 0) {
				visualWidths = sep.visualWidths.slice();
			}
		}

		const tableEl = document.createElement("table");
		tableEl.classList.add(EDITOR_TABLE_CLASS);

		const containerEl = document.createElement("div");
		containerEl.classList.add(EDITOR_TABLE_CONTAINER_CLASS);
		containerEl.appendChild(tableEl);

		for (const row of table.rows) {
			const tr = document.createElement("tr");
			for (const [colIdx, cell] of enumerate(row.cells)) {
				const td = document.createElement("td");
				const hasVisual = plugin.settings.opinionatedSizes && visualWidths && visualWidths.length > colIdx;
				const baseWidth = hasVisual
					? (visualWidths as number[])[colIdx]
					: (separatorWidths?.[colIdx] ?? 1);
				const cssWidth = Math.max(baseWidth, 1);
				if (hasVisual || separatorWidths) {
					// In opinionated mode with visual hints, widths are pixel-based.
					// Otherwise, they are approximate character widths.
					td.style.width = hasVisual ? `${cssWidth}px` : `${cssWidth}ch`;
				}
				MarkdownRenderer.render(plugin.app, cell.content, td, context.sourcePath, plugin)
				tr.appendChild(td);
			}
			tableEl.appendChild(tr);
		}

		const leftoverText = text.split("\n").slice(parts.length).join("\n");
		const leftover = document.createElement("div");
		MarkdownRenderer.render(plugin.app, leftoverText, leftover, context.sourcePath, plugin);
		p.replaceWith(containerEl);
		for (const child of Array.from(leftover.children)) {
			containerEl.parentElement?.appendChild(child);
		}
	}
}

function genCellCommand(callbackIfInCell: (editor: Editor, view: MarkdownView, parentEditor: EditorView) => void) {
	return function (checking: boolean, editor: Editor, view: MarkdownView) {
		// @ts-expect-error Accessing editorComponent which is a hidden field
		const editorComponent = editor.editorComponent;

		const isCell = editorComponent.isCellEditor === true;
		if (!isCell) {
			return false;
		}

		if (checking) {
			return isCell;
		}

		callbackIfInCell(editor, view, editorComponent.parentEditor);
	}
}

export default class GridTablePlugin extends Plugin {
	static instance: GridTablePlugin | null = null;
	settings: GridTablePluginSettings;

	async onload() {
		GridTablePlugin.instance = this;
		await this.loadSettings();
		this.registerEditorExtension(nestedEditorsFacet.of(new ObsidianEditorStorage(this)))
		this.registerEditorExtension(tableField);
		this.app.workspace.getActiveViewOfType(MarkdownView)
		this.registerEditorExtension(Prec.lowest(
			EditorView.focusChangeEffect.of((state, focusing) => {
				if (focusing) {
					const mdInfo = state.field(editorInfoField);
					// @ts-expect-error magic field injected by MarkdownController in ObsidianEditorMagic
					// which, if exists, indicates that the editor is a cell editor.
					if (mdInfo.nestedMdController == undefined) {
						// @ts-expect-error hidden field which gets filled when entering a nested editor
						// but doesn't get cleared out when refocusing on the main editor, so it
						// has to be cleared out manually (discovered via debugger).
						// Without this, the command palette (and possibly other internal state)
						// acts as if the focused editor is still the cell one, and not the main one.
						this.app.workspace._activeEditor = null;
					}
				}

				return null;
			}),
		));
		this.addCommand({
			id: 'grid-table-add-row-below',
			name: "Add Row Below",
			editorCheckCallback: genCellCommand((editor: Editor, view: MarkdownView, parentEditor: EditorView) => {
				// @ts-expect-error editorComponent is a hidden field
				const cellEl = editor.editorComponent.editorEl.parentElement.parentElement;
				if (!view.file) return;
				TableCommands.addRowBelow(cellEl, parentEditor, view.file)
			}),
		});
		this.addCommand({
			id: 'grid-table-add-row-above',
			name: "Add Row Above",
			editorCheckCallback: genCellCommand((editor: Editor, view: MarkdownView, parentEditor: EditorView) => {
				// @ts-expect-error editorComponent is a hidden field
				const cellEl = editor.editorComponent.editorEl.parentElement.parentElement;
				if (!view.file) return;
				TableCommands.addRowAbove(cellEl, parentEditor, view.file)
			}),
		});
		this.addCommand({
			id: 'grid-table-add-col-to-right',
			name: "Add Column to the Right",
			editorCheckCallback: genCellCommand((editor: Editor, view: MarkdownView, parentEditor: EditorView) => {
				// @ts-expect-error editorComponent is a hidden field
				const cellEl = editor.editorComponent.editorEl.parentElement.parentElement;
				if (!view.file) return;
				TableCommands.addColumnAfter(cellEl, parentEditor, view.file)
			}),
		});
		this.addCommand({
			id: 'grid-table-add-col-to-left',
			name: "Add Column to the Left",
			editorCheckCallback: genCellCommand((editor: Editor, view: MarkdownView, parentEditor: EditorView) => {
				// @ts-expect-error editorComponent is a hidden field
				const cellEl = editor.editorComponent.editorEl.parentElement.parentElement;
				if (!view.file) return;
				TableCommands.addColumnBefore(cellEl, parentEditor, view.file)
			}),
		});
		this.addCommand({
			id: 'grid-table-delete-row',
			name: "Delete Row",
			editorCheckCallback: genCellCommand((editor: Editor, view: MarkdownView, parentEditor: EditorView) => {
				// @ts-expect-error editorComponent is a hidden field
				const cellEl = editor.editorComponent.editorEl.parentElement.parentElement;
				TableCommands.deleteRowAt(cellEl, parentEditor);
			})
		});
		this.addCommand({
			id: 'grid-table-delete-col',
			name: "Delete Column",
			editorCheckCallback: genCellCommand((editor: Editor, view: MarkdownView, parentEditor: EditorView) => {
				// @ts-expect-error editorComponent is a hidden field
				const cellEl = editor.editorComponent.editorEl.parentElement.parentElement;
				TableCommands.deleteColumnAt(cellEl, parentEditor);
			})
		});
		this.addCommand({
			id: 'grid-table-delete-table',
			name: "Delete Table",
			editorCheckCallback: genCellCommand((editor: Editor, view: MarkdownView, parentEditor: EditorView) => {
				// @ts-expect-error editorComponent is a hidden field
				const cellEl = editor.editorComponent.editorEl.parentElement.parentElement;
				const tableEl = cellEl.parentElement.parentElement;
				TableCommands.deleteTable(tableEl, parentEditor);
			}),
		});
		this.addCommand({
			id: 'grid-table-shift-row-up',
			name: "Shift Row Up",
			editorCheckCallback: genCellCommand((editor: Editor, view: MarkdownView, parentEditor: EditorView) => {
				// @ts-expect-error editorComponent is a hidden field
				const cellEl = editor.editorComponent.editorEl.parentElement.parentElement;
				TableCommands.shiftRowUp(cellEl, parentEditor);
			}),
			hotkeys: [{
				key: "ArrowUp",
				modifiers: ['Ctrl', 'Shift', 'Alt']
			}]
		});
		this.addCommand({
			id: 'grid-table-shift-row-down',
			name: "Shift Row Down",
			editorCheckCallback: genCellCommand((editor: Editor, view: MarkdownView, parentEditor: EditorView) => {
				// @ts-expect-error editorComponent is a hidden field
				const cellEl = editor.editorComponent.editorEl.parentElement.parentElement;
				TableCommands.shiftRowDown(cellEl, parentEditor);
			}),
			hotkeys: [{
				key: "ArrowDown",
				modifiers: ['Ctrl', 'Shift', 'Alt']
			}]
		});
		this.addCommand({
			id: 'grid-table-shift-col-right',
			name: "Shift Column Right",
			editorCheckCallback: genCellCommand((editor: Editor, view: MarkdownView, parentEditor: EditorView) => {
				// @ts-expect-error editorComponent is a hidden field
				const cellEl = editor.editorComponent.editorEl.parentElement.parentElement;
				TableCommands.shiftColumnRight(cellEl, parentEditor);
			}),
			hotkeys: [{
				key: "ArrowRight",
				modifiers: ['Ctrl', 'Shift', 'Alt']
			}]
		});
		this.addCommand({
			id: 'grid-table-shift-col-left',
			name: "Shift Column Left",
			editorCheckCallback: genCellCommand((editor: Editor, view: MarkdownView, parentEditor: EditorView) => {
				// @ts-expect-error editorComponent is a hidden field
				const cellEl = editor.editorComponent.editorEl.parentElement.parentElement;
				TableCommands.shiftColumnLeft(cellEl, parentEditor);
			}),
			hotkeys: [{
				key: "ArrowLeft",
				modifiers: ['Ctrl', 'Shift', 'Alt']
			}]
		});
		this.addCommand({
			id: 'grid-table-insert-table',
			name: "Insert Table",
			editorCallback(editor, ctx) {
				const newTable = new TableContent(
					[
						new TableRow([new TableCell(""), new TableCell("")]),
						new TableRow([new TableCell(""), new TableCell("")]),
					]
				);
				const newTableContent = tableContentToString(newTable);
				editor.transaction({
					changes: [
						{
							text: newTableContent + "\n",
							from: editor.getCursor("from"),
							to: editor.getCursor("to")
						}
					]
				})

			}
		})
		this.registerMarkdownPostProcessor(renderTablesInMarkdown)


		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new GridTableSettingsTab(this.app, this));
	}

	onunload() {
		GridTablePlugin.instance = null;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class GridTableSettingsTab extends PluginSettingTab {
	plugin: GridTablePlugin;

	constructor(app: App, plugin: GridTablePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setHeading()
			.setName("Grid Tables");

		new Setting(containerEl)
			.setName("Enable opinionated column sizes")
			.setDesc("When enabled, column widths are stored as visual hints so you can shrink columns below their longest line length.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.opinionatedSizes)
					.onChange(async (value) => {
						this.plugin.settings.opinionatedSizes = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
