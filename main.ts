import { App, Editor, editorEditorField, editorInfoField, editorLivePreviewField, MarkdownPostProcessorContext, MarkdownRenderer, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { EditorState, Extension, Prec, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state"
import { Command, Decoration, DecorationSet, drawSelection, EditorView, keymap, ViewUpdate, WidgetType } from '@codemirror/view'
import { isValidTableSpec, lookAheadForTableParts, SeparatorLine, tableContentToString, tryParseTableFromParsedParts } from 'src/TableSerde';
import { TableCell, TableContent, TableRow } from 'src/TableData';
import { ObsidianEditorAdapter } from 'src/ObsidianEditorAdapter';
import { EDITOR_TABLE_CELL_CLASS, EDITOR_TABLE_CLASS, EDITOR_TABLE_ROW_CLASS } from 'src/consts';
import { syntaxTree } from '@codemirror/language';

// Remember to rename these classes and interfaces!

interface GridTablePluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: GridTablePluginSettings = {
	mySetting: 'default'
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

export class GridTableWidget extends WidgetType {
	table: TableContent
	lastFlushedLength: number
	file: TFile
	editors: ObsidianEditorAdapter[]

	constructor(table: TableContent, file: TFile, originalLength: number) {
		super()
		this.table = table;
		this.lastFlushedLength = originalLength
		this.file = file;
		this.editors = [];
	}
	updateDOM(dom: HTMLElement, view: EditorView): boolean {
		return true;
	}

	genTabHandler(shift: boolean, editor: ObsidianEditorAdapter, view: EditorView, containingTable: HTMLTableElement): Command {
		return (_cellView: EditorView) => {
			const myIndex = this.editors.indexOf(editor);

			if (myIndex == -1) {
				console.warn("Cell isn't part of known editors, so skipping it!");
				return false;
			}

			const direction = shift ? -1 : 1;

			if (!this.tryShiftFromBy(editor, direction)) {
				if (direction == 1) {
					const newRow = this.table.addRow();
					this.flushToFile(view, containingTable);
					const newTR = this.constructRow(newRow, editor.plugin, view, containingTable)
					containingTable.appendChild(newTR);

					// Try shifting now that new cell should be created.
					this.tryShiftFromBy(editor, 1);
				} else {
					console.warn("Doing nothing!");
				}
			}

			return true;
		}
	}

	constructRow(row: TableRow, plugin: Plugin, view: EditorView, containingTable: HTMLTableElement) {
		const tr = document.createElement("tr");
		tr.classList.add(EDITOR_TABLE_ROW_CLASS);

		for (const cell of row.cells) {
			if (!globalPlugin) {
				throw new Error("globalPlugin isn't set");
			}

			const [td, editor] = this.constructCell(plugin, view, cell, containingTable);

			editor.setContent(cell.content);
			this.editors.push(editor);
			tr.appendChild(td);
		}

		return tr;
	}

	tryShiftFromBy(fromEditor: ObsidianEditorAdapter, byAmount: number, newCellCallback: ((newEditor: EditorView) => void) | undefined = undefined): boolean {
		const editorIndex = this.editors.indexOf(fromEditor);
		if (editorIndex == -1) return false;
		const desired = editorIndex + byAmount;

		if (desired < 0 || desired >= this.editors.length) {
			return false;
		}

		this.editors[desired].focus();
		if (newCellCallback) {
			newCellCallback(this.editors[desired].editorView);
		}

		return true;
	}

	genShiftByOnConditionHandler(editor: ObsidianEditorAdapter, shiftBy: () => number, condition: (target: EditorView) => boolean, newCellCallback: ((newEditor: EditorView) => void) | undefined = undefined): Command {
		return (target: EditorView) => {
			if (condition(target)) {
				if (this.tryShiftFromBy(editor, shiftBy(), newCellCallback)) {
					return true;
				}
			}

			return false;
		}
	}

	constructCell(plugin: Plugin, view: EditorView, backingCell: TableCell, containingTable: HTMLTableElement): [HTMLTableCellElement, ObsidianEditorAdapter] {
		const td = document.createElement("td");
		td.classList.add(EDITOR_TABLE_CELL_CLASS);
		const containingDiv = document.createElement("div");
		const editor = new ObsidianEditorAdapter(plugin);

		editor.setExtraExtensionProvider(() => [
			Prec.highest(
				keymap.of([
					{
						key: 'Tab',
						run: this.genTabHandler(false, editor, view, containingTable),
						shift: this.genTabHandler(true, editor, view, containingTable),
						preventDefault: true,
					},
					{
						key: 'ArrowUp',
						run: this.genShiftByOnConditionHandler(
							editor,
							() => -this.table.columnCount,
							(cellEditor) => cellEditor.state.selection.main.head == 0,
							moveCursorToEnd,
						),
						preventDefault: true,
					},
					{
						key: 'ArrowDown',
						run: this.genShiftByOnConditionHandler(
							editor,
							() => this.table.columnCount,
							(cellEditor) => cellEditor.state.selection.main.head == cellEditor.state.doc.length,
							moveCursorToBeginning,
						),
						preventDefault: true,
					},
					{
						key: 'ArrowLeft',
						run: this.genShiftByOnConditionHandler(
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
						run: this.genShiftByOnConditionHandler(
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
		]);

		editor.mount(containingDiv, this.file);
		editor.setChangeHandler((update) => {
			if (update.docChanged) {
				const newContent = update.state.doc.toString();
				backingCell.content = newContent;

				this.flushToFile(view, containingTable);
			}
		});

		td.appendChild(containingDiv);

		return [td, editor];
	}

	toDOM(view: EditorView): HTMLElement {
		const div = document.createElement("div");
		if (globalPlugin == null) {
			div.innerText = "Loading...";
			return div;
		}

		const table = document.createElement("table");
		table.classList.add(EDITOR_TABLE_CLASS);

		for (const row of this.table.rows) {
			const tr = this.constructRow(row, globalPlugin, view, table);

			table.appendChild(tr);
		}

		div.appendChild(table);

		return div;
	}

	flushToFile(view: EditorView, tableElement: HTMLElement) {
		const from = view.posAtDOM(tableElement);
		const to = from + this.lastFlushedLength;
		const newTableRepr = tableContentToString(this.table) + "\n";
		view.dispatch({
			changes: { from: from, to: to, insert: newTableRepr }
		})
		this.lastFlushedLength = newTableRepr.length;
	}

	destroy(dom: HTMLElement): void {
		for (const newEditor of this.editors) {
			newEditor.unmount();
		}
		this.editors = [];
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
				console.log("Failed to parse table!");
				// Failed to parse table.
				continue;
			}

			const tableEndLine = tableStartLine + parts.length - 1;
			const from = tr.state.doc.line(tableStartLine).from;
			const to = tr.state.doc.line(tableEndLine).to + 1;

			if (isSourceMode) {
				builder.add(from, to, Decoration.mark({ class: 'HyperMD-table-row' }))
			} else {
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
		console.log(parts);
		console.log(text);
		let table = null;
		try {
			table = tryParseTableFromParsedParts(parts)
		} catch (e) {
			console.log("No table!");
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
		this.registerEditorExtension(tableField);
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
