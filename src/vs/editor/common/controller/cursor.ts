/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as nls from 'vs/nls';
import * as strings from 'vs/base/common/strings';
import { onUnexpectedError } from 'vs/base/common/errors';
import { EventEmitter } from 'vs/base/common/eventEmitter';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { ReplaceCommand } from 'vs/editor/common/commands/replaceCommand';
import { CursorCollection, ICursorCollectionState } from 'vs/editor/common/controller/cursorCollection';
import { IViewModelHelper, OneCursor, OneCursorOp, CursorContext } from 'vs/editor/common/controller/oneCursor';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { Selection, SelectionDirection } from 'vs/editor/common/core/selection';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { CursorColumns, EditOperationResult, CursorConfiguration } from 'vs/editor/common/controller/cursorCommon';
import { LanguageConfigurationRegistry } from 'vs/editor/common/modes/languageConfigurationRegistry';
import { ColumnSelection, IColumnSelectResult } from 'vs/editor/common/controller/cursorColumnSelection';
import { DeleteOperations } from 'vs/editor/common/controller/cursorDeleteOperations';
import { TypeOperations } from 'vs/editor/common/controller/cursorTypeOperations';
import { TextModelEventType, ModelRawContentChangedEvent, RawContentChangedType } from 'vs/editor/common/model/textModelEvents';

export const CursorEventType = {
	CursorPositionChanged: 'positionChanged',
	CursorSelectionChanged: 'selectionChanged',
	CursorRevealRange: 'revealRange',
	CursorScrollRequest: 'scrollRequest',
};

const enum RevealTarget {
	Primary = 0,
	TopMost = 1,
	BottomMost = 2
}

interface IOneCursorOperationContext {
	shouldReveal: boolean;
	shouldRevealHorizontal: boolean;
	shouldPushStackElementBefore: boolean;
	shouldPushStackElementAfter: boolean;
	executeCommand: editorCommon.ICommand;
	isAutoWhitespaceCommand: boolean;
}

interface IMultipleCursorOperationContext {
	cursorPositionChangeReason: editorCommon.CursorChangeReason;
	shouldReveal: boolean;
	shouldRevealVerticalInCenter: boolean;
	shouldRevealHorizontal: boolean;
	shouldRevealTarget: RevealTarget;
	shouldPushStackElementBefore: boolean;
	shouldPushStackElementAfter: boolean;
	eventSource: string;
	eventData: any;
	hasExecutedCommands: boolean;
	isCursorUndo: boolean;
	executeCommands: editorCommon.ICommand[];
	isAutoWhitespaceCommand: boolean[];
	setColumnSelectToLineNumber: number;
	setColumnSelectToVisualColumn: number;
}

interface IExecContext {
	selectionStartMarkers: string[];
	positionMarkers: string[];
}

interface ICommandData {
	operations: editorCommon.IIdentifiedSingleEditOperation[];
	hadTrackedRange: boolean;
}

interface ICommandsData {
	operations: editorCommon.IIdentifiedSingleEditOperation[];
	hadTrackedRanges: boolean[];
	anyoneHadTrackedRange: boolean;
}

export class Cursor extends EventEmitter {

	private configuration: editorCommon.IConfiguration;
	private context: CursorContext;
	private model: editorCommon.IModel;

	private modelUnbinds: IDisposable[];

	private cursors: CursorCollection;
	private cursorUndoStack: ICursorCollectionState[];
	private viewModelHelper: IViewModelHelper;

	private _isHandling: boolean;
	private _isDoingComposition: boolean;

	private enableEmptySelectionClipboard: boolean;

	private _handlers: {
		[key: string]: (ctx: IMultipleCursorOperationContext) => boolean;
	};

	constructor(configuration: editorCommon.IConfiguration, model: editorCommon.IModel, viewModelHelper: IViewModelHelper, enableEmptySelectionClipboard: boolean) {
		super([
			CursorEventType.CursorPositionChanged,
			CursorEventType.CursorSelectionChanged,
			CursorEventType.CursorRevealRange,
			CursorEventType.CursorScrollRequest
		]);
		this.configuration = configuration;
		this.model = model;
		this.viewModelHelper = viewModelHelper;
		this.enableEmptySelectionClipboard = enableEmptySelectionClipboard;

		const createCursorContext = () => {
			const config = new CursorConfiguration(
				this.model.getLanguageIdentifier(),
				this.model.getOneIndent(),
				this.model.getOptions(),
				this.configuration
			);
			this.context = new CursorContext(
				this.model,
				this.viewModelHelper,
				config
			);
			if (this.cursors) {
				this.cursors.updateContext(this.context);
			}
		};
		createCursorContext();

		this.cursors = new CursorCollection(this.context);
		this.cursorUndoStack = [];

		this._isHandling = false;
		this._isDoingComposition = false;

		this.modelUnbinds = [];

		this.modelUnbinds.push(this.model.addBulkListener((events) => {
			if (this._isHandling) {
				return;
			}

			let hadContentChange = false;
			let hadFlushEvent = false;
			for (let i = 0, len = events.length; i < len; i++) {
				const event = events[i];
				const eventType = event.type;

				if (eventType === TextModelEventType.ModelRawContentChanged2) {
					hadContentChange = true;
					const changeEvent = <ModelRawContentChangedEvent>event.data;

					for (let j = 0, lenJ = changeEvent.changes.length; j < lenJ; j++) {
						const change = changeEvent.changes[j];
						if (change.changeType === RawContentChangedType.Flush) {
							hadFlushEvent = true;
						}
					}
				}
			}

			if (!hadContentChange) {
				return;
			}

			this._onModelContentChanged(hadFlushEvent);
		}));

		this.modelUnbinds.push(this.model.onDidChangeLanguage((e) => {
			createCursorContext();
		}));
		this.modelUnbinds.push(LanguageConfigurationRegistry.onDidChange(() => {
			// TODO@Alex: react only if certain supports changed? (and if my model's mode changed)
			createCursorContext();
		}));
		this.modelUnbinds.push(model.onDidChangeOptions(() => {
			createCursorContext();
		}));
		this.modelUnbinds.push(this.configuration.onDidChange((e) => {
			if (CursorConfiguration.shouldRecreate(e)) {
				createCursorContext();
			}
		}));

		this._handlers = {};
		this._registerHandlers();
	}

	public dispose(): void {
		this.modelUnbinds = dispose(this.modelUnbinds);
		this.model = null;
		this.cursors.dispose();
		this.cursors = null;
		this.configuration = null;
		this.viewModelHelper = null;
		super.dispose();
	}

	public saveState(): editorCommon.ICursorState[] {

		var selections = this.cursors.getSelections(),
			result: editorCommon.ICursorState[] = [],
			selection: Selection;

		for (var i = 0; i < selections.length; i++) {
			selection = selections[i];

			result.push({
				inSelectionMode: !selection.isEmpty(),
				selectionStart: {
					lineNumber: selection.selectionStartLineNumber,
					column: selection.selectionStartColumn,
				},
				position: {
					lineNumber: selection.positionLineNumber,
					column: selection.positionColumn,
				}
			});
		}

		return result;
	}

	public restoreState(states: editorCommon.ICursorState[]): void {

		var desiredSelections: editorCommon.ISelection[] = [],
			state: editorCommon.ICursorState;

		for (var i = 0; i < states.length; i++) {
			state = states[i];

			var positionLineNumber = 1, positionColumn = 1;

			// Avoid missing properties on the literal
			if (state.position && state.position.lineNumber) {
				positionLineNumber = state.position.lineNumber;
			}
			if (state.position && state.position.column) {
				positionColumn = state.position.column;
			}

			var selectionStartLineNumber = positionLineNumber, selectionStartColumn = positionColumn;

			// Avoid missing properties on the literal
			if (state.selectionStart && state.selectionStart.lineNumber) {
				selectionStartLineNumber = state.selectionStart.lineNumber;
			}
			if (state.selectionStart && state.selectionStart.column) {
				selectionStartColumn = state.selectionStart.column;
			}

			desiredSelections.push({
				selectionStartLineNumber: selectionStartLineNumber,
				selectionStartColumn: selectionStartColumn,
				positionLineNumber: positionLineNumber,
				positionColumn: positionColumn
			});
		}

		this._onHandler('restoreState', (ctx: IMultipleCursorOperationContext) => {
			this.cursors.setSelections(desiredSelections);
			return false;
		}, 'restoreState', null);
	}

	private _onModelContentChanged(hadFlushEvent: boolean): void {
		if (hadFlushEvent) {
			// a model.setValue() was called
			this.cursors.dispose();

			this.cursors = new CursorCollection(this.context);

			this.emitCursorPositionChanged('model', editorCommon.CursorChangeReason.ContentFlush);
			this.emitCursorSelectionChanged('model', editorCommon.CursorChangeReason.ContentFlush);
		} else {
			if (!this._isHandling) {
				// Read the markers before entering `_onHandler`, since that would validate
				// the position and ruin the markers
				let selections: Selection[] = this.cursors.getAll().map((cursor) => {
					return cursor.beginRecoverSelectionFromMarkers(this.context);
				});
				this._onHandler('recoverSelectionFromMarkers', (ctx: IMultipleCursorOperationContext) => {
					ctx.shouldPushStackElementBefore = true;
					ctx.shouldPushStackElementAfter = true;
					var result = this._invokeForAll(ctx, (cursorIndex: number, oneCursor: OneCursor, oneCtx: IOneCursorOperationContext) => {
						ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.RecoverFromMarkers;
						ctx.shouldPushStackElementBefore = true;
						ctx.shouldPushStackElementAfter = true;
						ctx.shouldReveal = false;
						ctx.shouldRevealHorizontal = false;

						return oneCursor.endRecoverSelectionFromMarkers(this.context, selections[cursorIndex]);
					});
					ctx.shouldPushStackElementBefore = false;
					ctx.shouldPushStackElementAfter = false;
					return result;
				}, 'modelChange', null);
			}
		}
	}

	// ------ some getters/setters

	public getSelection(): Selection {
		return this.cursors.getSelection(0);
	}

	public getSelections(): Selection[] {
		return this.cursors.getSelections();
	}

	public getPosition(): Position {
		return this.cursors.getPosition(0);
	}

	public setSelections(source: string, selections: editorCommon.ISelection[]): void {
		this._onHandler('setSelections', (ctx: IMultipleCursorOperationContext) => {
			ctx.shouldReveal = false;
			this.cursors.setSelections(selections);
			return false;
		}, source, null);
	}

	// ------ auxiliary handling logic

	private _createAndInterpretHandlerCtx(eventSource: string, eventData: any, callback: (currentHandlerCtx: IMultipleCursorOperationContext) => void): boolean {

		var currentHandlerCtx: IMultipleCursorOperationContext = {
			cursorPositionChangeReason: editorCommon.CursorChangeReason.NotSet,
			shouldReveal: true,
			shouldRevealVerticalInCenter: false,
			shouldRevealHorizontal: true,
			shouldRevealTarget: RevealTarget.Primary,
			eventSource: eventSource,
			eventData: eventData,
			executeCommands: [],
			isAutoWhitespaceCommand: [],
			hasExecutedCommands: false,
			isCursorUndo: false,
			shouldPushStackElementBefore: false,
			shouldPushStackElementAfter: false,
			setColumnSelectToLineNumber: 0,
			setColumnSelectToVisualColumn: 0
		};

		callback(currentHandlerCtx);

		this._interpretHandlerContext(currentHandlerCtx);
		this.cursors.normalize();

		return currentHandlerCtx.hasExecutedCommands;
	}

	private _onHandler(command: string, handler: (ctx: IMultipleCursorOperationContext) => boolean, source: string, data: any): boolean {

		this._isHandling = true;

		var handled = false;

		try {
			var oldSelections = this.cursors.getSelections();
			var oldViewSelections = this.cursors.getViewSelections();

			// ensure valid state on all cursors
			this.cursors.ensureValidState();

			var prevCursorsState = this.cursors.saveState();

			var eventSource = source;
			var cursorPositionChangeReason: editorCommon.CursorChangeReason;
			var shouldReveal: boolean;
			var shouldRevealVerticalInCenter: boolean;
			var shouldRevealHorizontal: boolean;
			var shouldRevealTarget: RevealTarget;
			var isCursorUndo: boolean;

			var hasExecutedCommands = this._createAndInterpretHandlerCtx(eventSource, data, (currentHandlerCtx: IMultipleCursorOperationContext) => {
				handled = handler(currentHandlerCtx);

				cursorPositionChangeReason = currentHandlerCtx.cursorPositionChangeReason;
				shouldReveal = currentHandlerCtx.shouldReveal;
				shouldRevealTarget = currentHandlerCtx.shouldRevealTarget;
				shouldRevealVerticalInCenter = currentHandlerCtx.shouldRevealVerticalInCenter;
				shouldRevealHorizontal = currentHandlerCtx.shouldRevealHorizontal;
				isCursorUndo = currentHandlerCtx.isCursorUndo;
			});

			if (hasExecutedCommands) {
				this.cursorUndoStack = [];
			}

			var newSelections = this.cursors.getSelections();
			var newViewSelections = this.cursors.getViewSelections();

			var somethingChanged = false;
			if (oldSelections.length !== newSelections.length) {
				somethingChanged = true;
			} else {
				for (var i = 0, len = oldSelections.length; !somethingChanged && i < len; i++) {
					if (!oldSelections[i].equalsSelection(newSelections[i])) {
						somethingChanged = true;
					}
				}
				for (var i = 0, len = oldViewSelections.length; !somethingChanged && i < len; i++) {
					if (!oldViewSelections[i].equalsSelection(newViewSelections[i])) {
						somethingChanged = true;
					}
				}
			}


			if (somethingChanged) {
				if (!hasExecutedCommands && !isCursorUndo) {
					this.cursorUndoStack.push(prevCursorsState);
				}
				if (this.cursorUndoStack.length > 50) {
					this.cursorUndoStack = this.cursorUndoStack.splice(0, this.cursorUndoStack.length - 50);
				}
				this.emitCursorPositionChanged(eventSource, cursorPositionChangeReason);

				if (shouldReveal) {
					this.revealRange(shouldRevealTarget, shouldRevealVerticalInCenter ? editorCommon.VerticalRevealType.Center : editorCommon.VerticalRevealType.Simple, shouldRevealHorizontal);
				}
				this.emitCursorSelectionChanged(eventSource, cursorPositionChangeReason);
			}

		} catch (err) {
			onUnexpectedError(err);
		}

		this._isHandling = false;

		return handled;
	}

	private _interpretHandlerContext(ctx: IMultipleCursorOperationContext): void {
		if (ctx.shouldPushStackElementBefore) {
			this.model.pushStackElement();
			ctx.shouldPushStackElementBefore = false;
		}

		this._columnSelectToLineNumber = ctx.setColumnSelectToLineNumber;
		this._columnSelectToVisualColumn = ctx.setColumnSelectToVisualColumn;

		ctx.hasExecutedCommands = this._internalExecuteCommands(ctx.executeCommands, ctx.isAutoWhitespaceCommand) || ctx.hasExecutedCommands;
		ctx.executeCommands = [];

		if (ctx.shouldPushStackElementAfter) {
			this.model.pushStackElement();
			ctx.shouldPushStackElementAfter = false;
		}
	}

	private _interpretCommandResult(cursorState: Selection[]): boolean {
		if (!cursorState || cursorState.length === 0) {
			return false;
		}

		this.cursors.setSelections(cursorState);
		return true;
	}

	private _getEditOperationsFromCommand(ctx: IExecContext, majorIdentifier: number, command: editorCommon.ICommand, isAutoWhitespaceCommand: boolean): ICommandData {
		// This method acts as a transaction, if the command fails
		// everything it has done is ignored
		var operations: editorCommon.IIdentifiedSingleEditOperation[] = [],
			operationMinor = 0;

		var addEditOperation = (selection: Range, text: string) => {
			if (selection.isEmpty() && text === '') {
				// This command wants to add a no-op => no thank you
				return;
			}
			operations.push({
				identifier: {
					major: majorIdentifier,
					minor: operationMinor++
				},
				range: selection,
				text: text,
				forceMoveMarkers: false,
				isAutoWhitespaceEdit: isAutoWhitespaceCommand
			});
		};

		var hadTrackedRange = false;
		var trackSelection = (selection: Selection, trackPreviousOnEmpty?: boolean) => {
			var selectionMarkerStickToPreviousCharacter: boolean,
				positionMarkerStickToPreviousCharacter: boolean;

			if (selection.isEmpty()) {
				// Try to lock it with surrounding text
				if (typeof trackPreviousOnEmpty === 'boolean') {
					selectionMarkerStickToPreviousCharacter = trackPreviousOnEmpty;
					positionMarkerStickToPreviousCharacter = trackPreviousOnEmpty;
				} else {
					var maxLineColumn = this.model.getLineMaxColumn(selection.startLineNumber);
					if (selection.startColumn === maxLineColumn) {
						selectionMarkerStickToPreviousCharacter = true;
						positionMarkerStickToPreviousCharacter = true;
					} else {
						selectionMarkerStickToPreviousCharacter = false;
						positionMarkerStickToPreviousCharacter = false;
					}
				}
			} else {
				if (selection.getDirection() === SelectionDirection.LTR) {
					selectionMarkerStickToPreviousCharacter = false;
					positionMarkerStickToPreviousCharacter = true;
				} else {
					selectionMarkerStickToPreviousCharacter = true;
					positionMarkerStickToPreviousCharacter = false;
				}
			}

			var l = ctx.selectionStartMarkers.length;
			ctx.selectionStartMarkers[l] = this.model._addMarker(0, selection.selectionStartLineNumber, selection.selectionStartColumn, selectionMarkerStickToPreviousCharacter);
			ctx.positionMarkers[l] = this.model._addMarker(0, selection.positionLineNumber, selection.positionColumn, positionMarkerStickToPreviousCharacter);
			return l.toString();
		};

		var editOperationBuilder: editorCommon.IEditOperationBuilder = {
			addEditOperation: addEditOperation,
			trackSelection: trackSelection
		};

		try {
			command.getEditOperations(this.model, editOperationBuilder);
		} catch (e) {
			e.friendlyMessage = nls.localize('corrupt.commands', "Unexpected exception while executing command.");
			onUnexpectedError(e);
			return {
				operations: [],
				hadTrackedRange: false
			};
		}

		return {
			operations: operations,
			hadTrackedRange: hadTrackedRange
		};
	}

	private _getEditOperations(ctx: IExecContext, commands: editorCommon.ICommand[], isAutoWhitespaceCommand: boolean[]): ICommandsData {
		var oneResult: ICommandData;
		var operations: editorCommon.IIdentifiedSingleEditOperation[] = [];
		var hadTrackedRanges: boolean[] = [];
		var anyoneHadTrackedRange: boolean;

		for (var i = 0; i < commands.length; i++) {
			if (commands[i]) {
				oneResult = this._getEditOperationsFromCommand(ctx, i, commands[i], isAutoWhitespaceCommand[i]);
				operations = operations.concat(oneResult.operations);
				hadTrackedRanges[i] = oneResult.hadTrackedRange;
				anyoneHadTrackedRange = anyoneHadTrackedRange || hadTrackedRanges[i];
			} else {
				hadTrackedRanges[i] = false;
			}
		}
		return {
			operations: operations,
			hadTrackedRanges: hadTrackedRanges,
			anyoneHadTrackedRange: anyoneHadTrackedRange
		};
	}

	private _getLoserCursorMap(operations: editorCommon.IIdentifiedSingleEditOperation[]): { [index: string]: boolean; } {
		// This is destructive on the array
		operations = operations.slice(0);

		// Sort operations with last one first
		operations.sort((a: editorCommon.IIdentifiedSingleEditOperation, b: editorCommon.IIdentifiedSingleEditOperation): number => {
			// Note the minus!
			return -(Range.compareRangesUsingEnds(a.range, b.range));
		});

		// Operations can not overlap!
		var loserCursorsMap: { [index: string]: boolean; } = {};

		var previousOp: editorCommon.IIdentifiedSingleEditOperation;
		var currentOp: editorCommon.IIdentifiedSingleEditOperation;
		var loserMajor: number;

		for (var i = 1; i < operations.length; i++) {
			previousOp = operations[i - 1];
			currentOp = operations[i];

			if (previousOp.range.getStartPosition().isBefore(currentOp.range.getEndPosition())) {

				if (previousOp.identifier.major > currentOp.identifier.major) {
					// previousOp loses the battle
					loserMajor = previousOp.identifier.major;
				} else {
					loserMajor = currentOp.identifier.major;
				}

				loserCursorsMap[loserMajor.toString()] = true;

				for (var j = 0; j < operations.length; j++) {
					if (operations[j].identifier.major === loserMajor) {
						operations.splice(j, 1);
						if (j < i) {
							i--;
						}
						j--;
					}
				}

				if (i > 0) {
					i--;
				}
			}
		}

		return loserCursorsMap;
	}

	private _collapseDeleteCommands(rawCmds: editorCommon.ICommand[], isAutoWhitespaceCommand: boolean[]): boolean {
		if (rawCmds.length === 1) {
			return false;
		}

		// Merge adjacent delete commands
		var allAreDeleteCommands = rawCmds.every((command) => {
			if (!(command instanceof ReplaceCommand)) {
				return false;
			}
			var replCmd = (<ReplaceCommand>command);
			if (replCmd.getText().length > 0) {
				return false;
			}
			return true;
		});

		if (!allAreDeleteCommands) {
			return false;
		}

		var commands = <ReplaceCommand[]>rawCmds;
		var cursors = commands.map((cmd, i) => {
			return {
				range: commands[i].getRange(),
				order: i
			};
		});

		cursors.sort((a, b) => {
			return Range.compareRangesUsingStarts(a.range, b.range);
		});

		var previousCursor = cursors[0];
		for (var i = 1; i < cursors.length; i++) {
			if (previousCursor.range.endLineNumber === cursors[i].range.startLineNumber && previousCursor.range.endColumn === cursors[i].range.startColumn) {
				// Merge ranges
				var mergedRange = new Range(
					previousCursor.range.startLineNumber,
					previousCursor.range.startColumn,
					cursors[i].range.endLineNumber,
					cursors[i].range.endColumn
				);

				previousCursor.range = mergedRange;

				commands[cursors[i].order].setRange(mergedRange);
				commands[previousCursor.order].setRange(mergedRange);
			} else {
				// Push previous cursor
				previousCursor = cursors[i];
			}
		}
		return false;
	}

	private _internalExecuteCommands(commands: editorCommon.ICommand[], isAutoWhitespaceCommand: boolean[]): boolean {
		var ctx: IExecContext = {
			selectionStartMarkers: [],
			positionMarkers: []
		};

		this._collapseDeleteCommands(commands, isAutoWhitespaceCommand);

		var r = this._innerExecuteCommands(ctx, commands, isAutoWhitespaceCommand);
		for (var i = 0; i < ctx.selectionStartMarkers.length; i++) {
			this.model._removeMarker(ctx.selectionStartMarkers[i]);
			this.model._removeMarker(ctx.positionMarkers[i]);
		}
		return r;
	}

	private _arrayIsEmpty(commands: editorCommon.ICommand[]): boolean {
		var i: number,
			len: number;

		for (i = 0, len = commands.length; i < len; i++) {
			if (commands[i]) {
				return false;
			}
		}

		return true;
	}

	private _innerExecuteCommands(ctx: IExecContext, commands: editorCommon.ICommand[], isAutoWhitespaceCommand: boolean[]): boolean {

		if (this.configuration.editor.readOnly) {
			return false;
		}

		if (this._arrayIsEmpty(commands)) {
			return false;
		}

		var selectionsBefore = this.cursors.getSelections();

		var commandsData = this._getEditOperations(ctx, commands, isAutoWhitespaceCommand);
		if (commandsData.operations.length === 0 && !commandsData.anyoneHadTrackedRange) {
			return false;
		}

		var rawOperations = commandsData.operations;

		var editableRange = this.model.getEditableRange();
		var editableRangeStart = editableRange.getStartPosition();
		var editableRangeEnd = editableRange.getEndPosition();
		for (var i = 0; i < rawOperations.length; i++) {
			var operationRange = rawOperations[i].range;
			if (!editableRangeStart.isBeforeOrEqual(operationRange.getStartPosition()) || !operationRange.getEndPosition().isBeforeOrEqual(editableRangeEnd)) {
				// These commands are outside of the editable range
				return false;
			}
		}

		var loserCursorsMap = this._getLoserCursorMap(rawOperations);
		if (loserCursorsMap.hasOwnProperty('0')) {
			// These commands are very messed up
			console.warn('Ignoring commands');
			return false;
		}

		// Remove operations belonging to losing cursors
		var filteredOperations: editorCommon.IIdentifiedSingleEditOperation[] = [];
		for (var i = 0; i < rawOperations.length; i++) {
			if (!loserCursorsMap.hasOwnProperty(rawOperations[i].identifier.major.toString())) {
				filteredOperations.push(rawOperations[i]);
			}
		}

		var selectionsAfter = this.model.pushEditOperations(selectionsBefore, filteredOperations, (inverseEditOperations: editorCommon.IIdentifiedSingleEditOperation[]): Selection[] => {
			var groupedInverseEditOperations: editorCommon.IIdentifiedSingleEditOperation[][] = [];
			for (var i = 0; i < selectionsBefore.length; i++) {
				groupedInverseEditOperations[i] = [];
			}
			for (var i = 0; i < inverseEditOperations.length; i++) {
				var op = inverseEditOperations[i];
				if (!op.identifier) {
					// perhaps auto whitespace trim edits
					continue;
				}
				groupedInverseEditOperations[op.identifier.major].push(op);
			}
			var minorBasedSorter = (a: editorCommon.IIdentifiedSingleEditOperation, b: editorCommon.IIdentifiedSingleEditOperation) => {
				return a.identifier.minor - b.identifier.minor;
			};
			var cursorSelections: Selection[] = [];
			for (var i = 0; i < selectionsBefore.length; i++) {
				if (groupedInverseEditOperations[i].length > 0 || commandsData.hadTrackedRanges[i]) {
					groupedInverseEditOperations[i].sort(minorBasedSorter);
					cursorSelections[i] = commands[i].computeCursorState(this.model, {
						getInverseEditOperations: () => {
							return groupedInverseEditOperations[i];
						},

						getTrackedSelection: (id: string) => {
							var idx = parseInt(id, 10);
							var selectionStartMarker = this.model._getMarker(ctx.selectionStartMarkers[idx]);
							var positionMarker = this.model._getMarker(ctx.positionMarkers[idx]);
							return new Selection(selectionStartMarker.lineNumber, selectionStartMarker.column, positionMarker.lineNumber, positionMarker.column);
						}
					});
				} else {
					cursorSelections[i] = selectionsBefore[i];
				}
			}
			return cursorSelections;
		});

		// Extract losing cursors
		var losingCursorIndex: string;
		var losingCursors: number[] = [];
		for (losingCursorIndex in loserCursorsMap) {
			if (loserCursorsMap.hasOwnProperty(losingCursorIndex)) {
				losingCursors.push(parseInt(losingCursorIndex, 10));
			}
		}

		// Sort losing cursors descending
		losingCursors.sort((a: number, b: number): number => {
			return b - a;
		});

		// Remove losing cursors
		for (var i = 0; i < losingCursors.length; i++) {
			selectionsAfter.splice(losingCursors[i], 1);
		}

		return this._interpretCommandResult(selectionsAfter);
	}


	// -----------------------------------------------------------------------------------------------------------
	// ----- emitting events

	private emitCursorPositionChanged(source: string, reason: editorCommon.CursorChangeReason): void {
		var positions = this.cursors.getPositions();
		var primaryPosition = positions[0];
		var secondaryPositions = positions.slice(1);

		var viewPositions = this.cursors.getViewPositions();
		var primaryViewPosition = viewPositions[0];
		var secondaryViewPositions = viewPositions.slice(1);

		var isInEditableRange: boolean = true;
		if (this.model.hasEditableRange()) {
			var editableRange = this.model.getEditableRange();
			if (!editableRange.containsPosition(primaryPosition)) {
				isInEditableRange = false;
			}
		}
		var e: editorCommon.ICursorPositionChangedEvent = {
			position: primaryPosition,
			viewPosition: primaryViewPosition,
			secondaryPositions: secondaryPositions,
			secondaryViewPositions: secondaryViewPositions,
			reason: reason,
			source: source,
			isInEditableRange: isInEditableRange
		};
		this.emit(CursorEventType.CursorPositionChanged, e);
	}

	private emitCursorSelectionChanged(source: string, reason: editorCommon.CursorChangeReason): void {
		let selections = this.cursors.getSelections();
		let primarySelection = selections[0];
		let secondarySelections = selections.slice(1);

		let viewSelections = this.cursors.getViewSelections();
		let primaryViewSelection = viewSelections[0];
		let secondaryViewSelections = viewSelections.slice(1);

		let e: editorCommon.ICursorSelectionChangedEvent = {
			selection: primarySelection,
			viewSelection: primaryViewSelection,
			secondarySelections: secondarySelections,
			secondaryViewSelections: secondaryViewSelections,
			source: source,
			reason: reason
		};
		this.emit(CursorEventType.CursorSelectionChanged, e);
	}

	private emitCursorScrollRequest(deltaLines: number, revealCursor: boolean): void {
		var e: editorCommon.ICursorScrollRequestEvent = {
			deltaLines,
			revealCursor
		};
		this.emit(CursorEventType.CursorScrollRequest, e);
	}

	private revealRange(revealTarget: RevealTarget, verticalType: editorCommon.VerticalRevealType, revealHorizontal: boolean): void {
		var positions = this.cursors.getPositions();
		var viewPositions = this.cursors.getViewPositions();

		var position = positions[0];
		var viewPosition = viewPositions[0];

		if (revealTarget === RevealTarget.TopMost) {
			for (var i = 1; i < positions.length; i++) {
				if (positions[i].isBefore(position)) {
					position = positions[i];
					viewPosition = viewPositions[i];
				}
			}
		} else if (revealTarget === RevealTarget.BottomMost) {
			for (var i = 1; i < positions.length; i++) {
				if (position.isBeforeOrEqual(positions[i])) {
					position = positions[i];
					viewPosition = viewPositions[i];
				}
			}
		} else {
			if (positions.length > 1) {
				// no revealing!
				return;
			}
		}

		var range = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
		var viewRange = new Range(viewPosition.lineNumber, viewPosition.column, viewPosition.lineNumber, viewPosition.column);
		this.emitCursorRevealRange(range, viewRange, verticalType, revealHorizontal, false);
	}

	private emitCursorRevealRange(range: Range, viewRange: Range, verticalType: editorCommon.VerticalRevealType, revealHorizontal: boolean, revealCursor: boolean) {
		var e: editorCommon.ICursorRevealRangeEvent = {
			range: range,
			viewRange: viewRange,
			verticalType: verticalType,
			revealHorizontal: revealHorizontal,
			revealCursor: revealCursor
		};
		this.emit(CursorEventType.CursorRevealRange, e);
	}

	// -----------------------------------------------------------------------------------------------------------
	// ----- handlers beyond this point

	public trigger(source: string, handlerId: string, payload: any): void {
		if (!this._handlers.hasOwnProperty(handlerId)) {
			return;
		}
		let handler = this._handlers[handlerId];
		this._onHandler(handlerId, handler, source, payload);
	}

	private _registerHandlers(): void {
		let H = editorCommon.Handler;

		this._handlers[H.CursorMove] = (ctx) => this._cursorMove(ctx);
		this._handlers[H.MoveTo] = (ctx) => this._moveTo(false, ctx);
		this._handlers[H.MoveToSelect] = (ctx) => this._moveTo(true, ctx);
		this._handlers[H.ColumnSelect] = (ctx) => this._columnSelectMouse(ctx);
		this._handlers[H.AddCursorUp] = (ctx) => this._addCursorUp(ctx);
		this._handlers[H.AddCursorDown] = (ctx) => this._addCursorDown(ctx);
		this._handlers[H.CreateCursor] = (ctx) => this._createCursor(ctx);
		this._handlers[H.LastCursorMoveToSelect] = (ctx) => this._lastCursorMoveTo(ctx);


		this._handlers[H.CursorLeft] = (ctx) => this._moveLeft(false, ctx);
		this._handlers[H.CursorLeftSelect] = (ctx) => this._moveLeft(true, ctx);

		this._handlers[H.CursorRight] = (ctx) => this._moveRight(false, ctx);
		this._handlers[H.CursorRightSelect] = (ctx) => this._moveRight(true, ctx);

		this._handlers[H.CursorUp] = (ctx) => this._moveUp(false, false, ctx);
		this._handlers[H.CursorUpSelect] = (ctx) => this._moveUp(true, false, ctx);
		this._handlers[H.CursorDown] = (ctx) => this._moveDown(false, false, ctx);
		this._handlers[H.CursorDownSelect] = (ctx) => this._moveDown(true, false, ctx);

		this._handlers[H.CursorPageUp] = (ctx) => this._moveUp(false, true, ctx);
		this._handlers[H.CursorPageUpSelect] = (ctx) => this._moveUp(true, true, ctx);
		this._handlers[H.CursorPageDown] = (ctx) => this._moveDown(false, true, ctx);
		this._handlers[H.CursorPageDownSelect] = (ctx) => this._moveDown(true, true, ctx);

		this._handlers[H.CursorHome] = (ctx) => this._moveToBeginningOfLine(false, ctx);
		this._handlers[H.CursorHomeSelect] = (ctx) => this._moveToBeginningOfLine(true, ctx);

		this._handlers[H.CursorEnd] = (ctx) => this._moveToEndOfLine(false, ctx);
		this._handlers[H.CursorEndSelect] = (ctx) => this._moveToEndOfLine(true, ctx);

		this._handlers[H.CursorTop] = (ctx) => this._moveToBeginningOfBuffer(false, ctx);
		this._handlers[H.CursorTopSelect] = (ctx) => this._moveToBeginningOfBuffer(true, ctx);
		this._handlers[H.CursorBottom] = (ctx) => this._moveToEndOfBuffer(false, ctx);
		this._handlers[H.CursorBottomSelect] = (ctx) => this._moveToEndOfBuffer(true, ctx);

		this._handlers[H.CursorColumnSelectLeft] = (ctx) => this._columnSelectLeft(ctx);
		this._handlers[H.CursorColumnSelectRight] = (ctx) => this._columnSelectRight(ctx);
		this._handlers[H.CursorColumnSelectUp] = (ctx) => this._columnSelectUp(false, ctx);
		this._handlers[H.CursorColumnSelectPageUp] = (ctx) => this._columnSelectUp(true, ctx);
		this._handlers[H.CursorColumnSelectDown] = (ctx) => this._columnSelectDown(false, ctx);
		this._handlers[H.CursorColumnSelectPageDown] = (ctx) => this._columnSelectDown(true, ctx);

		this._handlers[H.SelectAll] = (ctx) => this._selectAll(ctx);

		this._handlers[H.LineSelect] = (ctx) => this._line(false, ctx);
		this._handlers[H.LineSelectDrag] = (ctx) => this._line(true, ctx);
		this._handlers[H.LastCursorLineSelect] = (ctx) => this._lastCursorLine(false, ctx);
		this._handlers[H.LastCursorLineSelectDrag] = (ctx) => this._lastCursorLine(true, ctx);

		this._handlers[H.LineInsertBefore] = (ctx) => this._lineInsertBefore(ctx);
		this._handlers[H.LineInsertAfter] = (ctx) => this._lineInsertAfter(ctx);
		this._handlers[H.LineBreakInsert] = (ctx) => this._lineBreakInsert(ctx);

		this._handlers[H.WordSelect] = (ctx) => this._word(false, ctx);
		this._handlers[H.WordSelectDrag] = (ctx) => this._word(true, ctx);
		this._handlers[H.LastCursorWordSelect] = (ctx) => this._lastCursorWord(ctx);
		this._handlers[H.CancelSelection] = (ctx) => this._cancelSelection(ctx);
		this._handlers[H.RemoveSecondaryCursors] = (ctx) => this._removeSecondaryCursors(ctx);

		this._handlers[H.Type] = (ctx) => this._type(ctx);
		this._handlers[H.ReplacePreviousChar] = (ctx) => this._replacePreviousChar(ctx);
		this._handlers[H.CompositionStart] = (ctx) => this._compositionStart(ctx);
		this._handlers[H.CompositionEnd] = (ctx) => this._compositionEnd(ctx);
		this._handlers[H.Tab] = (ctx) => this._tab(ctx);
		this._handlers[H.Indent] = (ctx) => this._indent(ctx);
		this._handlers[H.Outdent] = (ctx) => this._outdent(ctx);
		this._handlers[H.Paste] = (ctx) => this._paste(ctx);

		this._handlers[H.EditorScroll] = (ctx) => this._editorScroll(ctx);

		this._handlers[H.ScrollLineUp] = (ctx) => this._scrollUp(false, ctx);
		this._handlers[H.ScrollLineDown] = (ctx) => this._scrollDown(false, ctx);
		this._handlers[H.ScrollPageUp] = (ctx) => this._scrollUp(true, ctx);
		this._handlers[H.ScrollPageDown] = (ctx) => this._scrollDown(true, ctx);

		this._handlers[H.DeleteLeft] = (ctx) => this._deleteLeft(ctx);
		this._handlers[H.DeleteRight] = (ctx) => this._deleteRight(ctx);

		this._handlers[H.Cut] = (ctx) => this._cut(ctx);

		this._handlers[H.ExpandLineSelection] = (ctx) => this._expandLineSelection(ctx);

		this._handlers[H.Undo] = (ctx) => this._undo(ctx);
		this._handlers[H.CursorUndo] = (ctx) => this._cursorUndo(ctx);
		this._handlers[H.Redo] = (ctx) => this._redo(ctx);

		this._handlers[H.ExecuteCommand] = (ctx) => this._externalExecuteCommand(ctx);
		this._handlers[H.ExecuteCommands] = (ctx) => this._externalExecuteCommands(ctx);

		this._handlers[H.RevealLine] = (ctx) => this._revealLine(ctx);
	}

	private _invokeForAllSorted(ctx: IMultipleCursorOperationContext, callable: (cursorIndex: number, cursor: OneCursor, ctx: IOneCursorOperationContext) => boolean): boolean {
		return this._doInvokeForAll(ctx, true, callable);
	}

	private _invokeForAll(ctx: IMultipleCursorOperationContext, callable: (cursorIndex: number, cursor: OneCursor, ctx: IOneCursorOperationContext) => boolean): boolean {
		return this._doInvokeForAll(ctx, false, callable);
	}

	private _doInvokeForAll(ctx: IMultipleCursorOperationContext, sorted: boolean, callable: (cursorIndex: number, cursor: OneCursor, ctx: IOneCursorOperationContext) => boolean): boolean {
		let result = false;
		let cursors = this.cursors.getAll();

		if (sorted) {
			cursors = cursors.sort((a, b) => {
				return Range.compareRangesUsingStarts(a.modelState.selection, b.modelState.selection);
			});
		}

		let context: IOneCursorOperationContext;

		for (let i = 0; i < cursors.length; i++) {
			context = {
				shouldReveal: true,
				shouldRevealHorizontal: true,
				executeCommand: null,
				isAutoWhitespaceCommand: false,
				shouldPushStackElementBefore: false,
				shouldPushStackElementAfter: false
			};

			result = callable(i, cursors[i], context) || result;

			if (i === 0) {
				ctx.shouldRevealHorizontal = context.shouldRevealHorizontal;
				ctx.shouldReveal = context.shouldReveal;
			}

			ctx.shouldPushStackElementBefore = ctx.shouldPushStackElementBefore || context.shouldPushStackElementBefore;
			ctx.shouldPushStackElementAfter = ctx.shouldPushStackElementAfter || context.shouldPushStackElementAfter;

			ctx.executeCommands[i] = context.executeCommand;
			ctx.isAutoWhitespaceCommand[i] = context.isAutoWhitespaceCommand;
		}

		return result;
	}

	private _moveTo(inSelectionMode: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		if (ctx.eventSource === 'api') {
			ctx.shouldRevealVerticalInCenter = true;
		}
		if (ctx.eventSource === 'mouse') {
			ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		}
		const result = OneCursorOp.moveTo(this.context, this.cursors.getPrimaryCursor(), inSelectionMode, ctx.eventData.position, ctx.eventData.viewPosition);
		this.cursors.setStates([result], false);
		return true;
	}

	private _cursorMove(ctx: IMultipleCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.shouldReveal = true;
		ctx.shouldRevealHorizontal = true;
		this.cursors.setStates(OneCursorOp.move(this.context, this.cursors.getAll(), ctx.eventData), true);
		return true;
	}

	private _columnSelectToLineNumber: number = 0;
	private _getColumnSelectToLineNumber(): number {
		if (!this._columnSelectToLineNumber) {
			let primaryCursor = this.cursors.getPrimaryCursor();
			let primaryPos = primaryCursor.viewState.position;
			return primaryPos.lineNumber;
		}
		return this._columnSelectToLineNumber;
	}

	private _columnSelectToVisualColumn: number = 0;
	private _getColumnSelectToVisualColumn(): number {
		if (!this._columnSelectToVisualColumn) {
			let primaryCursor = this.cursors.getPrimaryCursor();
			let primaryPos = primaryCursor.viewState.position;
			return CursorColumns.visibleColumnFromColumn2(this.context.config, this.context.viewModel, primaryPos);
		}
		return this._columnSelectToVisualColumn;
	}

	private _columnSelectMouse(ctx: IMultipleCursorOperationContext): boolean {
		let primary = this.cursors.getPrimaryCursor();

		// validate `eventData`
		let validatedPosition = this.context.model.validatePosition(ctx.eventData.position);
		let validatedViewPosition: Position;
		if (ctx.eventData.viewPosition) {
			validatedViewPosition = this.context.validateViewPosition(new Position(ctx.eventData.viewPosition.lineNumber, ctx.eventData.viewPosition.column), validatedPosition);
		} else {
			validatedViewPosition = this.context.convertModelPositionToViewPosition(validatedPosition);
		}

		let result = ColumnSelection.columnSelect(this.context.config, this.context.viewModel, primary.viewState.selection, validatedViewPosition.lineNumber, ctx.eventData.mouseColumn - 1);
		let selections = result.viewSelections.map(viewSel => this.context.convertViewSelectionToModelSelection(viewSel));

		ctx.shouldRevealTarget = (result.reversed ? RevealTarget.TopMost : RevealTarget.BottomMost);
		ctx.shouldReveal = true;
		ctx.setColumnSelectToLineNumber = result.toLineNumber;
		ctx.setColumnSelectToVisualColumn = result.toVisualColumn;

		this.cursors.setSelections(selections, result.viewSelections);
		return true;
	}

	private _columnSelectOp(ctx: IMultipleCursorOperationContext, op: (cursor: OneCursor, toViewLineNumber: number, toViewVisualColumn: number) => IColumnSelectResult): boolean {
		let primary = this.cursors.getPrimaryCursor();
		let result = op(primary, this._getColumnSelectToLineNumber(), this._getColumnSelectToVisualColumn());
		let selections = result.viewSelections.map(viewSel => this.context.convertViewSelectionToModelSelection(viewSel));

		ctx.shouldRevealTarget = (result.reversed ? RevealTarget.TopMost : RevealTarget.BottomMost);
		ctx.shouldReveal = true;
		ctx.setColumnSelectToLineNumber = result.toLineNumber;
		ctx.setColumnSelectToVisualColumn = result.toVisualColumn;

		this.cursors.setSelections(selections, result.viewSelections);
		return true;
	}

	private _columnSelectLeft(ctx: IMultipleCursorOperationContext): boolean {
		return this._columnSelectOp(ctx, (cursor, toViewLineNumber, toViewVisualColumn) => ColumnSelection.columnSelectLeft(this.context.config, this.context.viewModel, cursor.viewState, toViewLineNumber, toViewVisualColumn));
	}

	private _columnSelectRight(ctx: IMultipleCursorOperationContext): boolean {
		return this._columnSelectOp(ctx, (cursor, toViewLineNumber, toViewVisualColumn) => ColumnSelection.columnSelectRight(this.context.config, this.context.viewModel, cursor.viewState, toViewLineNumber, toViewVisualColumn));
	}

	private _columnSelectUp(isPaged: boolean, ctx: IMultipleCursorOperationContext): boolean {
		return this._columnSelectOp(ctx, (cursor, toViewLineNumber, toViewVisualColumn) => ColumnSelection.columnSelectUp(this.context.config, this.context.viewModel, cursor.viewState, isPaged, toViewLineNumber, toViewVisualColumn));
	}

	private _columnSelectDown(isPaged: boolean, ctx: IMultipleCursorOperationContext): boolean {
		return this._columnSelectOp(ctx, (cursor, toViewLineNumber, toViewVisualColumn) => ColumnSelection.columnSelectDown(this.context.config, this.context.viewModel, cursor.viewState, isPaged, toViewLineNumber, toViewVisualColumn));
	}

	private _createCursor(ctx: IMultipleCursorOperationContext): boolean {
		if (this.configuration.editor.readOnly || this.model.hasEditableRange()) {
			return false;
		}

		this.cursors.addSecondaryCursor({
			selectionStartLineNumber: 1,
			selectionStartColumn: 1,
			positionLineNumber: 1,
			positionColumn: 1
		});

		const lastAddedCursor = this.cursors.getLastAddedCursor();
		if (ctx.eventData.wholeLine) {
			const result = OneCursorOp.line(this.context, lastAddedCursor, false, ctx.eventData.position, ctx.eventData.viewPosition);
			lastAddedCursor.setState(this.context, result.modelState, result.viewState, false);
		} else {
			const result = OneCursorOp.moveTo(this.context, lastAddedCursor, false, ctx.eventData.position, ctx.eventData.viewPosition);
			lastAddedCursor.setState(this.context, result.modelState, result.viewState, false);
		}

		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldReveal = false;
		ctx.shouldRevealHorizontal = false;

		return true;
	}

	private _lastCursorMoveTo(ctx: IMultipleCursorOperationContext): boolean {
		if (this.configuration.editor.readOnly || this.model.hasEditableRange()) {
			return false;
		}

		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		if (ctx.eventSource === 'mouse') {
			ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		}
		ctx.shouldReveal = false;
		ctx.shouldRevealHorizontal = false;

		const lastAddedCursor = this.cursors.getLastAddedCursor();
		const result = OneCursorOp.moveTo(this.context, lastAddedCursor, true, ctx.eventData.position, ctx.eventData.viewPosition);
		lastAddedCursor.setState(this.context, result.modelState, result.viewState, false);

		return true;
	}

	private _addCursorUp(ctx: IMultipleCursorOperationContext): boolean {
		if (this.configuration.editor.readOnly) {
			return false;
		}
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldRevealTarget = RevealTarget.TopMost;
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;

		this.cursors.setStates(OneCursorOp.addCursorUp(this.context, this.cursors.getAll()), true);
		return true;
	}

	private _addCursorDown(ctx: IMultipleCursorOperationContext): boolean {
		if (this.configuration.editor.readOnly) {
			return false;
		}
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldRevealTarget = RevealTarget.BottomMost;
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;

		this.cursors.setStates(OneCursorOp.addCursorDown(this.context, this.cursors.getAll()), true);
		return true;
	}

	private _moveLeft(inSelectionMode: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.eventData = ctx.eventData || {};
		ctx.eventData.to = editorCommon.CursorMovePosition.Left;
		ctx.eventData.select = inSelectionMode;

		return this._cursorMove(ctx);
	}

	private _moveRight(inSelectionMode: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.eventData = ctx.eventData || {};
		ctx.eventData.to = editorCommon.CursorMovePosition.Right;
		ctx.eventData.select = inSelectionMode;

		return this._cursorMove(ctx);
	}

	private _moveDown(inSelectionMode: boolean, isPaged: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.eventData = ctx.eventData || {};
		ctx.eventData.to = editorCommon.CursorMovePosition.Down;
		ctx.eventData.select = inSelectionMode;
		ctx.eventData.by = editorCommon.CursorMoveByUnit.WrappedLine;
		ctx.eventData.isPaged = isPaged;

		return this._cursorMove(ctx);
	}

	private _moveUp(inSelectionMode: boolean, isPaged: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.eventData = ctx.eventData || {};
		ctx.eventData.to = editorCommon.CursorMovePosition.Up;
		ctx.eventData.select = inSelectionMode;
		ctx.eventData.by = editorCommon.CursorMoveByUnit.WrappedLine;
		ctx.eventData.isPaged = isPaged;

		return this._cursorMove(ctx);
	}

	private _moveToBeginningOfLine(inSelectionMode: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		this.cursors.setStates(OneCursorOp.moveToBeginningOfLine(this.context, this.cursors.getAll(), inSelectionMode), true);
		return true;
	}

	private _moveToEndOfLine(inSelectionMode: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		this.cursors.setStates(OneCursorOp.moveToEndOfLine(this.context, this.cursors.getAll(), inSelectionMode), true);
		return true;
	}

	private _moveToBeginningOfBuffer(inSelectionMode: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		this.cursors.setStates(OneCursorOp.moveToBeginningOfBuffer(this.context, this.cursors.getAll(), inSelectionMode), true);
		return true;
	}

	private _moveToEndOfBuffer(inSelectionMode: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		this.cursors.setStates(OneCursorOp.moveToEndOfBuffer(this.context, this.cursors.getAll(), inSelectionMode), true);
		return true;
	}

	private _selectAll(ctx: IMultipleCursorOperationContext): boolean {
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.shouldReveal = false;
		ctx.shouldRevealHorizontal = false;
		const result = OneCursorOp.selectAll(this.context, this.cursors.getPrimaryCursor());
		this.cursors.setStates([result], false);
		return true;
	}

	private _line(inSelectionMode: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldRevealHorizontal = false;

		const r = OneCursorOp.line(this.context, this.cursors.getPrimaryCursor(), inSelectionMode, ctx.eventData.position, ctx.eventData.viewPosition);
		this.cursors.setStates([r], false);
		return true;
	}

	private _lastCursorLine(inSelectionMode: boolean, ctx: IMultipleCursorOperationContext): boolean {
		if (this.configuration.editor.readOnly || this.model.hasEditableRange()) {
			return false;
		}

		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldReveal = false;
		ctx.shouldRevealHorizontal = false;

		const lastAddedCursor = this.cursors.getLastAddedCursor();
		const result = OneCursorOp.line(this.context, lastAddedCursor, inSelectionMode, ctx.eventData.position, ctx.eventData.viewPosition);
		lastAddedCursor.setState(this.context, result.modelState, result.viewState, false);
		return true;
	}

	private _expandLineSelection(ctx: IMultipleCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		this.cursors.setStates(OneCursorOp.expandLineSelection(this.context, this.cursors.getAll()), true);
		return true;
	}

	private _word(inSelectionMode: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;

		const primaryCursor = this.cursors.getPrimaryCursor();
		const r = OneCursorOp.word(this.context, primaryCursor, inSelectionMode, ctx.eventData.position);
		this.cursors.setStates([r], false);

		return true;
	}

	private _lastCursorWord(ctx: IMultipleCursorOperationContext): boolean {
		if (this.configuration.editor.readOnly || this.model.hasEditableRange()) {
			return false;
		}

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.shouldReveal = false;
		ctx.shouldRevealHorizontal = false;

		const lastAddedCursor = this.cursors.getLastAddedCursor();
		const r = OneCursorOp.word(this.context, lastAddedCursor, true, ctx.eventData.position);
		lastAddedCursor.setState(this.context, r.modelState, r.viewState, false);
		return true;
	}

	private _removeSecondaryCursors(ctx: IMultipleCursorOperationContext): boolean {
		this.cursors.killSecondaryCursors();
		return true;
	}

	private _cancelSelection(ctx: IMultipleCursorOperationContext): boolean {
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		const r = OneCursorOp.cancelSelection(this.context, this.cursors.getPrimaryCursor());
		this.cursors.setStates([r], false);
		return true;
	}

	// -------------------- START editing operations

	private _doApplyEdit(cursorIndex: number, oneCursor: OneCursor, oneCtx: IOneCursorOperationContext, callable: (oneCursor: OneCursor, cursorIndex: number) => EditOperationResult): boolean {
		let r = callable(oneCursor, cursorIndex);
		if (r) {
			oneCtx.executeCommand = r.command;
			oneCtx.shouldPushStackElementBefore = r.shouldPushStackElementBefore;
			oneCtx.shouldPushStackElementAfter = r.shouldPushStackElementAfter;
			oneCtx.isAutoWhitespaceCommand = r.isAutoWhitespaceCommand;
			oneCtx.shouldRevealHorizontal = r.shouldRevealHorizontal;
		}
		return true;
	}

	private _applyEditForAll(ctx: IMultipleCursorOperationContext, callable: (oneCursor: OneCursor, cursorIndex: number) => EditOperationResult): boolean {
		ctx.shouldPushStackElementBefore = false;
		ctx.shouldPushStackElementAfter = false;
		return this._invokeForAll(ctx, (cursorIndex: number, oneCursor: OneCursor, oneCtx: IOneCursorOperationContext) => this._doApplyEdit(cursorIndex, oneCursor, oneCtx, callable));
	}

	private _applyEditForAllSorted(ctx: IMultipleCursorOperationContext, callable: (oneCursor: OneCursor, cursorIndex: number) => EditOperationResult): boolean {
		ctx.shouldPushStackElementBefore = false;
		ctx.shouldPushStackElementAfter = false;
		return this._invokeForAllSorted(ctx, (cursorIndex: number, oneCursor: OneCursor, oneCtx: IOneCursorOperationContext) => this._doApplyEdit(cursorIndex, oneCursor, oneCtx, callable));
	}

	private _lineInsertBefore(ctx: IMultipleCursorOperationContext): boolean {
		return this._applyEditForAll(ctx, (cursor) => TypeOperations.lineInsertBefore(this.context.config, this.context.model, cursor.modelState));
	}

	private _lineInsertAfter(ctx: IMultipleCursorOperationContext): boolean {
		return this._applyEditForAll(ctx, (cursor) => TypeOperations.lineInsertAfter(this.context.config, this.context.model, cursor.modelState));
	}

	private _lineBreakInsert(ctx: IMultipleCursorOperationContext): boolean {
		return this._applyEditForAll(ctx, (cursor) => TypeOperations.lineBreakInsert(this.context.config, this.context.model, cursor.modelState));
	}

	private _type(ctx: IMultipleCursorOperationContext): boolean {
		var text = ctx.eventData.text;

		if (!this._isDoingComposition && ctx.eventSource === 'keyboard') {
			// If this event is coming straight from the keyboard, look for electric characters and enter

			for (let i = 0, len = text.length; i < len; i++) {
				let charCode = text.charCodeAt(i);
				let chr: string;
				if (strings.isHighSurrogate(charCode) && i + 1 < len) {
					chr = text.charAt(i) + text.charAt(i + 1);
					i++;
				} else {
					chr = text.charAt(i);
				}

				// Here we must interpret each typed character individually, that's why we create a new context
				ctx.hasExecutedCommands = this._createAndInterpretHandlerCtx(ctx.eventSource, ctx.eventData, (charHandlerCtx: IMultipleCursorOperationContext) => {

					// Decide what all cursors will do up-front
					const cursors = this.cursors.getAll();
					const states = cursors.map(cursor => cursor.modelState);
					const editOperations = TypeOperations.typeWithInterceptors(this.context.config, this.context.model, states, chr);
					this._applyEditForAll(charHandlerCtx, (cursor, cursorIndex) => editOperations[cursorIndex]);

					// The last typed character gets to win
					ctx.cursorPositionChangeReason = charHandlerCtx.cursorPositionChangeReason;
					ctx.shouldReveal = charHandlerCtx.shouldReveal;
					ctx.shouldRevealVerticalInCenter = charHandlerCtx.shouldRevealVerticalInCenter;
					ctx.shouldRevealHorizontal = charHandlerCtx.shouldRevealHorizontal;
				}) || ctx.hasExecutedCommands;

			}
		} else {
			this._applyEditForAll(ctx, (cursor) => TypeOperations.typeWithoutInterceptors(this.context.config, this.context.model, cursor.modelState, text));
		}

		return true;
	}

	private _replacePreviousChar(ctx: IMultipleCursorOperationContext): boolean {
		let text = ctx.eventData.text;
		let replaceCharCnt = ctx.eventData.replaceCharCnt;
		return this._applyEditForAll(ctx, (cursor) => TypeOperations.replacePreviousChar(this.context.config, this.context.model, cursor.modelState, text, replaceCharCnt));
	}

	private _compositionStart(ctx: IMultipleCursorOperationContext): boolean {
		this._isDoingComposition = true;
		return true;
	}

	private _compositionEnd(ctx: IMultipleCursorOperationContext): boolean {
		this._isDoingComposition = false;
		return true;
	}

	private _tab(ctx: IMultipleCursorOperationContext): boolean {
		return this._applyEditForAll(ctx, (cursor) => TypeOperations.tab(this.context.config, this.context.model, cursor.modelState));
	}

	private _indent(ctx: IMultipleCursorOperationContext): boolean {
		this._applyEditForAll(ctx, (cursor) => TypeOperations.indent(this.context.config, this.context.model, cursor.modelState));
		return true;
	}

	private _outdent(ctx: IMultipleCursorOperationContext): boolean {
		this._applyEditForAll(ctx, (cursor) => TypeOperations.outdent(this.context.config, this.context.model, cursor.modelState));
		return true;
	}

	private _distributePasteToCursors(ctx: IMultipleCursorOperationContext): string[] {
		if (ctx.eventData.pasteOnNewLine) {
			return null;
		}

		var selections = this.cursors.getSelections();
		if (selections.length === 1) {
			return null;
		}

		for (var i = 0; i < selections.length; i++) {
			if (selections[i].startLineNumber !== selections[i].endLineNumber) {
				return null;
			}
		}

		var pastePieces = ctx.eventData.text.split(/\r\n|\r|\n/);
		if (pastePieces.length !== selections.length) {
			return null;
		}

		return pastePieces;
	}

	private _paste(ctx: IMultipleCursorOperationContext): boolean {
		var distributedPaste = this._distributePasteToCursors(ctx);

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Paste;
		if (distributedPaste) {
			return this._applyEditForAllSorted(ctx, (cursor, cursorIndex) => TypeOperations.paste(this.context.config, this.context.model, cursor.modelState, distributedPaste[cursorIndex], false));
		} else {
			return this._applyEditForAll(ctx, (cursor) => TypeOperations.paste(this.context.config, this.context.model, cursor.modelState, ctx.eventData.text, ctx.eventData.pasteOnNewLine));
		}
	}

	private _deleteLeft(ctx: IMultipleCursorOperationContext): boolean {
		return this._applyEditForAll(ctx, (cursor) => DeleteOperations.deleteLeft(this.context.config, this.context.model, cursor.modelState));
	}

	private _deleteRight(ctx: IMultipleCursorOperationContext): boolean {
		return this._applyEditForAll(ctx, (cursor) => DeleteOperations.deleteRight(this.context.config, this.context.model, cursor.modelState));
	}

	private _cut(ctx: IMultipleCursorOperationContext): boolean {
		return this._applyEditForAll(ctx, (cursor) => DeleteOperations.cut(this.context.config, this.context.model, cursor.modelState, this.enableEmptySelectionClipboard));
	}

	// -------------------- END editing operations


	private _revealLine(ctx: IMultipleCursorOperationContext): boolean {
		const revealLineArg: editorCommon.RevealLineArguments = ctx.eventData;
		const lineNumber = revealLineArg.lineNumber + 1;
		let range = this.model.validateRange({
			startLineNumber: lineNumber,
			startColumn: 1,
			endLineNumber: lineNumber,
			endColumn: 1
		});
		range = new Range(range.startLineNumber, range.startColumn, range.endLineNumber, this.model.getLineMaxColumn(range.endLineNumber));

		let revealAt = editorCommon.VerticalRevealType.Simple;
		if (revealLineArg.at) {
			switch (revealLineArg.at) {
				case editorCommon.RevealLineAtArgument.Top:
					revealAt = editorCommon.VerticalRevealType.Top;
					break;
				case editorCommon.RevealLineAtArgument.Center:
					revealAt = editorCommon.VerticalRevealType.Center;
					break;
				case editorCommon.RevealLineAtArgument.Bottom:
					revealAt = editorCommon.VerticalRevealType.Bottom;
					break;
				default:
					break;
			}
		}

		this.emitCursorRevealRange(range, null, revealAt, false, false);
		return true;
	}

	private _editorScroll(ctx: IMultipleCursorOperationContext): boolean {
		let editorScrollArg: editorCommon.EditorScrollArguments = ctx.eventData;
		editorScrollArg.value = editorScrollArg.value || 1;
		switch (editorScrollArg.to) {
			case editorCommon.EditorScrollDirection.Up:
			case editorCommon.EditorScrollDirection.Down:
				return this._scrollUpOrDown(editorScrollArg, ctx);
		}
		return true;
	}

	private _scrollUpOrDown(editorScrollArg: editorCommon.EditorScrollArguments, ctx: IMultipleCursorOperationContext): boolean {
		if (this._scrollByReveal(editorScrollArg, ctx)) {
			return true;
		}
		let up = editorScrollArg.to === editorCommon.EditorScrollDirection.Up;
		let noOfLines = editorScrollArg.value || 1;
		switch (editorScrollArg.by) {
			case editorCommon.EditorScrollByUnit.Page:
				noOfLines = this.context.config.pageSize * noOfLines;
				break;
			case editorCommon.EditorScrollByUnit.HalfPage:
				noOfLines = Math.round(this.context.config.pageSize / 2) * noOfLines;
				break;
		}
		this.emitCursorScrollRequest((up ? -1 : 1) * noOfLines, !!editorScrollArg.revealCursor);
		return true;
	}

	private _scrollByReveal(editorScrollArg: editorCommon.EditorScrollArguments, ctx: IMultipleCursorOperationContext): boolean {
		let up = editorScrollArg.to === editorCommon.EditorScrollDirection.Up;
		if (editorCommon.EditorScrollByUnit.Line !== editorScrollArg.by) {
			// Scroll by reveal is done only when unit is line.
			return false;
		}
		if (!up && this.context.isLastLineVisibleInViewPort()) {
			// Scroll by reveal is not done if last line is visible and scrolling down.
			return false;
		}
		let range = up ? this.context.getRangeToRevealModelLinesBeforeViewPortTop(editorScrollArg.value) : this.context.getRangeToRevealModelLinesAfterViewPortBottom(editorScrollArg.value);
		this.emitCursorRevealRange(range, null, up ? editorCommon.VerticalRevealType.Top : editorCommon.VerticalRevealType.Bottom, false, true);
		return true;
	}

	private _scrollUp(isPaged: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.eventData = <editorCommon.EditorScrollArguments>{ to: editorCommon.EditorScrollDirection.Up, value: 1 };
		ctx.eventData.by = isPaged ? editorCommon.EditorScrollByUnit.Page : editorCommon.EditorScrollByUnit.WrappedLine;
		return this._editorScroll(ctx);
	}

	private _scrollDown(isPaged: boolean, ctx: IMultipleCursorOperationContext): boolean {
		ctx.eventData = <editorCommon.EditorScrollArguments>{ to: editorCommon.EditorScrollDirection.Down, value: 1 };
		ctx.eventData.by = isPaged ? editorCommon.EditorScrollByUnit.Page : editorCommon.EditorScrollByUnit.WrappedLine;
		return this._editorScroll(ctx);
	}

	private _undo(ctx: IMultipleCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Undo;
		ctx.hasExecutedCommands = true;
		this._interpretCommandResult(this.model.undo());
		return true;
	}

	private _cursorUndo(ctx: IMultipleCursorOperationContext): boolean {
		if (this.cursorUndoStack.length === 0) {
			return false;
		}
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Undo;
		ctx.isCursorUndo = true;
		this.cursors.restoreState(this.cursorUndoStack.pop());
		return true;
	}

	private _redo(ctx: IMultipleCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Redo;
		ctx.hasExecutedCommands = true;
		this._interpretCommandResult(this.model.redo());
		return true;
	}

	private _externalExecuteCommand(ctx: IMultipleCursorOperationContext): boolean {
		this.cursors.killSecondaryCursors();
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		return this._invokeForAll(ctx, (cursorIndex: number, oneCursor: OneCursor, oneCtx: IOneCursorOperationContext) => {
			oneCtx.shouldPushStackElementBefore = true;
			oneCtx.shouldPushStackElementAfter = true;
			oneCtx.executeCommand = ctx.eventData;
			return false;
		});
	}

	private _externalExecuteCommands(ctx: IMultipleCursorOperationContext): boolean {
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		return this._invokeForAll(ctx, (cursorIndex: number, oneCursor: OneCursor, oneCtx: IOneCursorOperationContext) => {
			oneCtx.shouldPushStackElementBefore = true;
			oneCtx.shouldPushStackElementAfter = true;
			oneCtx.executeCommand = ctx.eventData[cursorIndex];
			return false;
		});
	}
}
