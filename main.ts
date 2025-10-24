import { App, Editor, editorEditorField, editorInfoField, editorLivePreviewField, MarkdownRenderer, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { EditorState, Extension, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state"
import { Decoration, DecorationSet, EditorView, ViewUpdate, WidgetType } from '@codemirror/view'
import { lookAheadForTableParts, SeparatorLine, tableContentToString, tryParseTableFromParsedParts } from 'src/TableSerde';
import { TableContent } from 'src/TableData';
import { ObsidianEditorAdapter } from 'src/ObsidianEditorAdapter';

// Remember to rename these classes and interfaces!

interface GridTablePluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: GridTablePluginSettings = {
	mySetting: 'default'
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

export class GridTableWidget extends WidgetType {
	table: TableContent
	from: number
	to: number
	file: TFile
	newEditors: ObsidianEditorAdapter[]

	constructor(table: TableContent, file: TFile, originalFrom: number, originalTo: number) {
		super()
		this.table = table;
		this.from = originalFrom;
		this.to = originalTo;
		this.file = file;
		this.newEditors = [];
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

				if (!globalPlugin) {
					throw new Error("globalPlugin isn't set");
				}

				const editor = new ObsidianEditorAdapter(globalApp, globalPlugin);
				editor.mount(containingDiv, this.file);
				editor.setChangeHandler((up: ViewUpdate) => {
					if (up.docChanged) {
						const newContent = up.state.doc.toString();
						cell.content = newContent;

						const from = this.from;
						const to = this.to;
						const newTableRepr = tableContentToString(this.table) + "\n";
						view.dispatch({
							changes: { from: from, to: to, insert: newTableRepr }
						})
						this.to = this.from + newTableRepr.length;
					}
				});
				editor.setContent(cell.content);
				this.newEditors.push(editor);

				td.appendChild(containingDiv);
				tr.appendChild(td);
			}
			table.appendChild(tr);
		}

		div.appendChild(table);

		return div;
	}
	destroy(dom: HTMLElement): void {
		for (const newEditor of this.newEditors) {
			newEditor.unmount();
		}
		this.newEditors = [];
	}
}

let globalApp: App | null = null;

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
		for (const line of tr.state.doc.iterLines()) {
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
					(index) => tr.state.doc.line(index).text,
					tableStartLine,
					tr.startState.doc.lines
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
				builder.add(from, to, Decoration.replace({
					widget: new GridTableWidget(table, fileRef, from, to)
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


let globalPlugin: GridTablePlugin | null = null;

export default class GridTablePlugin extends Plugin {
	settings: GridTablePluginSettings;

	async onload() {
		globalPlugin = this;
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
