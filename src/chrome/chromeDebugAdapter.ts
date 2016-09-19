/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {DebugProtocol} from 'vscode-debugprotocol';
import {StoppedEvent, InitializedEvent, TerminatedEvent, OutputEvent, Handles, ContinuedEvent, BreakpointEvent} from 'vscode-debugadapter';

import {ILaunchRequestArgs, ISetBreakpointsArgs, ISetBreakpointsResponseBody, IStackTraceResponseBody,
    IAttachRequestArgs, IScopesResponseBody, IVariablesResponseBody,
    ISourceResponseBody, IThreadsResponseBody, IEvaluateResponseBody, ISetVariableResponseBody} from '../debugAdapterInterfaces';
import {IChromeDebugSessionOpts} from './chromeDebugSession';
import {ChromeConnection} from './chromeConnection';
import * as ChromeUtils from './chromeUtils';
import {formatConsoleMessage} from './consoleHelper';
import * as Chrome from './chromeDebugProtocol';
import {PropertyContainer, ScopeContainer, IVariableContainer, isIndexedPropName} from './variables';

import * as errors from '../errors';
import * as utils from '../utils';
import * as logger from '../logger';
import {BaseDebugAdapter} from '../baseDebugAdapter';

import {LineNumberTransformer} from '../transformers/lineNumberTransformer';
import {BasePathTransformer} from '../transformers/basePathTransformer';
import {RemotePathTransformer} from '../transformers/remotePathTransformer';
import {BaseSourceMapTransformer} from '../transformers/baseSourceMapTransformer';
import {EagerSourceMapTransformer} from '../transformers/eagerSourceMapTransformer';

import * as path from 'path';

interface IPropCount {
    indexedVariables: number;
    namedVariables: number;
}

/**
 * Represents a reference to a source/script. `contents` is set if there are inlined sources.
 * Otherwise, scriptId can be used to retrieve the contents from the runtime.
 */
export interface ISourceContainer {
    /** The runtime-side scriptId of this script */
    scriptId?: Chrome.Debugger.ScriptId;
    /** The contents of this script, if they are inlined in the sourcemap */
    contents?: string;
    /** The authored path to this script (only set if the contents are inlined) */
    mappedPath?: string;
}

export abstract class ChromeDebugAdapter extends BaseDebugAdapter {
    private static THREAD_ID = 1;
    private static PAGE_PAUSE_MESSAGE = 'Paused in Visual Studio Code';
    private static EXCEPTION_VALUE_ID = 'EXCEPTION_VALUE_ID';
    private static PLACEHOLDER_URL_PROTOCOL = 'debugadapter://';

    private _clientAttached: boolean;
    private _currentStack: Chrome.Debugger.CallFrame[];
    private _committedBreakpointsByUrl: Map<string, Chrome.Debugger.BreakpointId[]>;
    private _overlayHelper: utils.DebounceHelper;
    private _exceptionValueObject: Chrome.Runtime.RemoteObject;
    private _expectingResumedEvent: boolean;
    private _setBreakpointsRequestQ: Promise<any>;

    private _variableHandles: Handles<IVariableContainer>;
    private _breakpointIdHandles: utils.ReverseHandles<string>;
    private _sourceHandles: Handles<ISourceContainer>;

    private _scriptsById: Map<Chrome.Debugger.ScriptId, Chrome.Debugger.Script>;
    private _scriptsByUrl: Map<string, Chrome.Debugger.Script>;

    protected _chromeConnection: ChromeConnection;

    private _lineNumberTransformer: LineNumberTransformer;
    private _sourceMapTransformer: BaseSourceMapTransformer;
    private _pathTransformer: BasePathTransformer;

    private _hasTerminated: boolean;
    protected _inShutdown: boolean;
    protected _attachMode: boolean;

    public constructor({chromeConnection, lineNumberTransformer, sourceMapTransformer, pathTransformer }: IChromeDebugSessionOpts) {
        super();

        this._chromeConnection = chromeConnection || new ChromeConnection();

        this._variableHandles = new Handles<IVariableContainer>();
        this._breakpointIdHandles = new utils.ReverseHandles<string>();
        this._sourceHandles = new Handles<ISourceContainer>();

        this._overlayHelper = new utils.DebounceHelper(/*timeoutMs=*/200);

        this._lineNumberTransformer = lineNumberTransformer || new LineNumberTransformer(/*targetLinesStartAt1=*/false);
        this._sourceMapTransformer = sourceMapTransformer || new EagerSourceMapTransformer(this._sourceHandles);
        this._pathTransformer = pathTransformer || new RemotePathTransformer();

        this.clearEverything();
    }

    private get paused(): boolean {
        return !!this._currentStack;
    }

    /**
     * Called on 'clearEverything' or on a navigation/refresh
     */
    protected clearTargetContext(): void {
        this._sourceMapTransformer.clearTargetContext();

        this._scriptsById = new Map<Chrome.Debugger.ScriptId, Chrome.Debugger.Script>();
        this._scriptsByUrl = new Map<string, Chrome.Debugger.Script>();

        this._committedBreakpointsByUrl = new Map<string, Chrome.Debugger.BreakpointId[]>();
        this._setBreakpointsRequestQ = Promise.resolve<void>();

        this._pathTransformer.clearTargetContext();
    }

    private clearClientContext(): void {
        this._attachMode = false;
        this._clientAttached = false;
        this._pathTransformer.clearClientContext();
    }

    public initialize(args: DebugProtocol.InitializeRequestArguments): DebugProtocol.Capabilites {
        this._lineNumberTransformer.initialize(args);

        // This debug adapter supports two exception breakpoint filters
        return {
            exceptionBreakpointFilters: [
                {
                    label: 'All Exceptions',
                    filter: 'all',
                    default: false
                },
                {
                    label: 'Uncaught Exceptions',
                    filter: 'uncaught',
                    default: true
                }
            ],
            supportsConfigurationDoneRequest: true,
            supportsSetVariable: true
        };
    }

    public configurationDone(): Promise<void> {
        return Promise.resolve<void>();
    }

    public launch(args: ILaunchRequestArgs): Promise<void> {
        this._sourceMapTransformer.launch(args);
        this._pathTransformer.launch(args);

        this.setupLogging(args);

        return Promise.resolve<void>();
    }

    public attach(args: IAttachRequestArgs): Promise<void> {
        this._attachMode = true;
        this._sourceMapTransformer.attach(args);
        this._pathTransformer.attach(args);

        if (args.port == null) {
            return utils.errP('The "port" field is required in the attach config.');
        }

        this.setupLogging(args);

        return this.doAttach(args.port, args.url, args.address);
    }

    public setupLogging(args: IAttachRequestArgs | ILaunchRequestArgs): void {
        const minLogLevel =
            args.verboseDiagnosticLogging ?
                logger.LogLevel.Verbose :
            args.diagnosticLogging ?
                logger.LogLevel.Log :
                logger.LogLevel.Error;
        logger.setMinLogLevel(minLogLevel);

        if (!args.webRoot) {
            logger.log('WARNING: "webRoot" is not set - if resolving sourcemaps fails, please set the "webRoot" property in the launch config.');
        }
    }

    /**
     * From DebugSession
     */
    public shutdown(): void {
        this._inShutdown = true;
    }

    /**
     * Chrome is closing, or error'd somehow, stop the debug session
     */
    public terminateSession(reason: string, restart?: boolean): void {
        logger.log('Terminated: ' + reason);

        if (!this._hasTerminated) {
            this._hasTerminated = true;
            if (this._clientAttached) {
                this.sendEvent(new TerminatedEvent(restart));
            }

            this.clearEverything();
        }
    }

    public clearEverything(): void {
        this.clearClientContext();
        this.clearTargetContext();

        if (this._chromeConnection.isAttached) {
            this._chromeConnection.close();
        }
    }

    protected doAttach(port: number, targetUrl?: string, address?: string, timeout?: number): Promise<void> {
        // Client is attaching - if not attached to the chrome target, create a connection and attach
        this._clientAttached = true;
        if (!this._chromeConnection.isAttached) {
            this._chromeConnection.on('Debugger.paused', params => this.onDebuggerPaused(params));
            this._chromeConnection.on('Debugger.resumed', () => this.onDebuggerResumed());
            this._chromeConnection.on('Debugger.scriptParsed', params => this.onScriptParsed(params));
            this._chromeConnection.on('Debugger.globalObjectCleared', () => this.onGlobalObjectCleared());
            this._chromeConnection.on('Debugger.breakpointResolved', params => this.onBreakpointResolved(params));

            this._chromeConnection.on('Console.messageAdded', params => this.onConsoleMessage(params));

            this._chromeConnection.on('Inspector.detached', () => this.terminateSession('Debug connection detached'));
            this._chromeConnection.on('close', () => this.terminateSession('Debug connection closed'));
            this._chromeConnection.on('error', e => this.terminateSession('Debug connection error: ' + e));

            return this._chromeConnection.attach(address, port, targetUrl).then(
                () => this.sendInitializedEvent(),
                e => {
                    this.clearEverything();
                    return utils.errP(e);
                });
        } else {
            return Promise.resolve<void>();
        }
    }

    /**
     * This event tells the client to begin sending setBP requests, etc. Some consumers need to override this
     * to send it at a later time of their choosing.
     */
    protected sendInitializedEvent(): void {
        this.sendEvent(new InitializedEvent());
    }

    /**
     * e.g. the target navigated
     */
    private onGlobalObjectCleared(): void {
        this.clearTargetContext();
    }

    protected onDebuggerPaused(notification: Chrome.Debugger.PausedParams): void {
        this._overlayHelper.doAndCancel(() => this._chromeConnection.page_setOverlayMessage(ChromeDebugAdapter.PAGE_PAUSE_MESSAGE));
        this._currentStack = notification.callFrames;

        // We can tell when we've broken on an exception. Otherwise if hitBreakpoints is set, assume we hit a
        // breakpoint. If not set, assume it was a step. We can't tell the difference between step and 'break on anything'.
        let reason: string;
        let exceptionText: string;
        if (notification.reason === 'exception') {
            reason = 'exception';
            if (notification.data && this._currentStack.length) {
                // Insert a scope to wrap the exception object. exceptionText is unused by Code at the moment.
                let scopeObject: Chrome.Runtime.RemoteObject;

                if (notification.data.objectId) {
                    // If the remote object is an object (probably an Error), treat the object like a scope.
                    exceptionText = notification.data.description;
                    scopeObject = notification.data;
                } else {
                    // If it's a value, use a special flag and save the value for later.
                    exceptionText = notification.data.value;
                    scopeObject = <any>{ objectId: ChromeDebugAdapter.EXCEPTION_VALUE_ID };
                    this._exceptionValueObject = notification.data;
                }

                this._currentStack[0].scopeChain.unshift({ type: 'Exception', object: scopeObject });
            }
        } else {
            reason = (notification.hitBreakpoints && notification.hitBreakpoints.length) ? 'breakpoint' : 'step';
        }

        this.sendEvent(new StoppedEvent(reason, /*threadId=*/ChromeDebugAdapter.THREAD_ID, exceptionText));
    }

    protected onDebuggerResumed(): void {
        this._overlayHelper.wait(() => this._chromeConnection.page_clearOverlayMessage());
        this._currentStack = null;

        if (!this._expectingResumedEvent) {
            let resumedEvent = new ContinuedEvent(ChromeDebugAdapter.THREAD_ID);
            this.sendEvent(resumedEvent);
        } else {
            this._expectingResumedEvent = false;
        }
    }

    protected onScriptParsed(script: Chrome.Debugger.Script): void {
        // Totally ignore extension scripts, internal Chrome scripts, and so on
        if (this.shouldIgnoreScript(script)) {
            return;
        }

        if (!script.url) {
            script.url = ChromeDebugAdapter.PLACEHOLDER_URL_PROTOCOL + script.scriptId;
        }

        this._scriptsById.set(script.scriptId, script);
        this._scriptsByUrl.set(script.url, script);

        const mappedUrl = this._pathTransformer.scriptParsed(script.url);
        this._sourceMapTransformer.scriptParsed(mappedUrl, script.sourceMapURL);
    }

    protected onBreakpointResolved(params: Chrome.Debugger.BreakpointResolvedParams): void {
        const script = this._scriptsById.get(params.location.scriptId);
        if (!script) {
            // Breakpoint resolved for a script we don't know about
            return;
        }

        const committedBps = this._committedBreakpointsByUrl.get(script.url) || [];
        committedBps.push(params.breakpointId);
        this._committedBreakpointsByUrl.set(script.url, committedBps);

        const bp = <DebugProtocol.Breakpoint>{
            id: this._breakpointIdHandles.lookup(params.breakpointId),
            verified: true,
            line: params.location.lineNumber,
            column: params.location.columnNumber
        };
        const scriptPath = this._pathTransformer.breakpointResolved(bp, script.url);
        this._sourceMapTransformer.breakpointResolved(bp, scriptPath);
        this._lineNumberTransformer.breakpointResolved(bp);
        this.sendEvent(new BreakpointEvent('new', bp));
    }

    protected onConsoleMessage(params: Chrome.Console.MessageAddedParams): void {
        const formattedMessage = formatConsoleMessage(params.message);
        if (formattedMessage) {
            this.sendEvent(new OutputEvent(
                formattedMessage.text + '\n',
                formattedMessage.isError ? 'stderr' : 'stdout'));
        }
    }

    public disconnect(): Promise<void> {
        this.clearEverything();

        return Promise.resolve<void>();
    }

    public setBreakpoints(args: ISetBreakpointsArgs, requestSeq: number): Promise<ISetBreakpointsResponseBody> {
        this._lineNumberTransformer.setBreakpoints(args);
        return this._sourceMapTransformer.setBreakpoints(args, requestSeq)
            .then(() => this._pathTransformer.setBreakpoints(args))
            .then(() => {
                let targetScriptUrl: string;
                if (args.source.path) {
                    targetScriptUrl = args.source.path;
                } else if (args.source.sourceReference) {
                    const handle = this._sourceHandles.get(args.source.sourceReference);
                    const targetScript = this._scriptsById.get(handle.scriptId);
                    if (targetScript) {
                        targetScriptUrl = targetScript.url;
                    }
                }

                if (targetScriptUrl) {
                    // DebugProtocol sends all current breakpoints for the script. Clear all scripts for the breakpoint then add all of them
                    const setBreakpointsPFailOnError = this._setBreakpointsRequestQ
                        .then(() => this.clearAllBreakpoints(targetScriptUrl))
                        .then(() => this.addBreakpoints(targetScriptUrl, args.lines, args.cols))
                        .then(responses => ({ breakpoints: this.chromeBreakpointResponsesToODPBreakpoints(targetScriptUrl, responses, args.lines) }));

                    const setBreakpointsPTimeout = utils.promiseTimeout(setBreakpointsPFailOnError, /*timeoutMs*/2000, 'Set breakpoints request timed out');

                    // Do just one setBreakpointsRequest at a time to avoid interleaving breakpoint removed/breakpoint added requests to Chrome.
                    // Swallow errors in the promise queue chain so it doesn't get blocked, but return the failing promise for error handling.
                    this._setBreakpointsRequestQ = setBreakpointsPTimeout.catch(() => undefined);
                    return setBreakpointsPTimeout.then(body => {
                        this._sourceMapTransformer.setBreakpointsResponse(body, requestSeq);
                        this._lineNumberTransformer.setBreakpointsResponse(body);
                        return body;
                    });
                } else {
                    return utils.errP(`Can't find script for breakpoint request`);
                }
            });
    }

    public setFunctionBreakpoints(): Promise<any> {
        return Promise.resolve<void>();
    }

    private clearAllBreakpoints(url: string): Promise<void> {
        if (!this._committedBreakpointsByUrl.has(url)) {
            return Promise.resolve<void>();
        }

        // Remove breakpoints one at a time. Seems like it would be ok to send the removes all at once,
        // but there is a chrome bug where when removing 5+ or so breakpoints at once, it gets into a weird
        // state where later adds on the same line will fail with 'breakpoint already exists' even though it
        // does not break there.
        return this._committedBreakpointsByUrl.get(url).reduce((p, bpId) => {
            return p.then(() => this._chromeConnection.debugger_removeBreakpoint(bpId)).then(() => { });
        }, Promise.resolve<void>()).then(() => {
            this._committedBreakpointsByUrl.set(url, null);
        });
    }

    /**
     * Makes the actual call to either Debugger.setBreakpoint or Debugger.setBreakpointByUrl, and returns the response.
     * Responses from setBreakpointByUrl are transformed to look like the response from setBreakpoint, so they can be
     * handled the same.
     */
    protected addBreakpoints(url: string, lines: number[], cols?: number[]): Promise<Chrome.Debugger.SetBreakpointResponse[]> {
        let responsePs: Promise<Chrome.Debugger.SetBreakpointResponse>[];
        if (url.startsWith(ChromeDebugAdapter.PLACEHOLDER_URL_PROTOCOL)) {
            // eval script with no real url - use debugger_setBreakpoint
            const scriptId = utils.lstrip(url, ChromeDebugAdapter.PLACEHOLDER_URL_PROTOCOL);
            responsePs = lines.map((lineNumber, i) => this._chromeConnection.debugger_setBreakpoint({ scriptId, lineNumber, columnNumber: cols ? cols[i] : 0 }));
        } else {
            // script that has a url - use debugger_setBreakpointByUrl so that Chrome will rebind the breakpoint immediately
            // after refreshing the page. This is the only way to allow hitting breakpoints in code that runs immediately when
            // the page loads.
            const script = this._scriptsByUrl.get(url);
            responsePs = lines.map((lineNumber, i) => {
                return this._chromeConnection.debugger_setBreakpointByUrl(url, lineNumber, cols ? cols[i] : 0).then(response => {
                    // Now convert the response to a SetBreakpointResponse so both response types can be handled the same
                    const locations = response.result.locations;
                    return <Chrome.Debugger.SetBreakpointResponse>{
                        id: response.id,
                        error: response.error,
                        result: {
                            breakpointId: response.result.breakpointId,
                            actualLocation: locations[0] && {
                                lineNumber: locations[0].lineNumber,
                                columnNumber: locations[0].columnNumber,
                                scriptId: script.scriptId
                            }
                        }
                    };
                });
            });
        }

        // Join all setBreakpoint requests to a single promise
        return Promise.all(responsePs);
    }

    private chromeBreakpointResponsesToODPBreakpoints(url: string, responses: Chrome.Debugger.SetBreakpointResponse[], requestLines: number[]): DebugProtocol.Breakpoint[] {
        // Don't cache errored responses
        const committedBpIds = responses
            .filter(response => !response.error)
            .map(response => response.result.breakpointId);

        // Cache successfully set breakpoint ids from chrome in committedBreakpoints set
        this._committedBreakpointsByUrl.set(url, committedBpIds);

        // Map committed breakpoints to DebugProtocol response breakpoints
        return responses
            .map((response, i) => {
                const id = response.result ? this._breakpointIdHandles.create(response.result.breakpointId) : undefined;

                // The output list needs to be the same length as the input list, so map errors to
                // unverified breakpoints.
                if (response.error || !response.result.actualLocation) {
                    return <DebugProtocol.Breakpoint>{
                        id,
                        verified: false,
                        line: requestLines[i],
                        column: 0,
                    };
                }

                return <DebugProtocol.Breakpoint>{
                    id,
                    verified: true,
                    line: response.result.actualLocation.lineNumber,
                    column: response.result.actualLocation.columnNumber
                };
            });
    }

    public setExceptionBreakpoints(args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {
        let state: string;
        if (args.filters.indexOf('all') >= 0) {
            state = 'all';
        } else if (args.filters.indexOf('uncaught') >= 0) {
            state = 'uncaught';
        } else {
            state = 'none';
        }

        return this._chromeConnection.debugger_setPauseOnExceptions(state)
            .then(() => { });
    }

    public continue(): Promise<void> {
        this._expectingResumedEvent = true;
        return this._chromeConnection.debugger_resume()
            .then(() => { });
    }

    public next(): Promise<void> {
        this._expectingResumedEvent = true;
        return this._chromeConnection.debugger_stepOver()
            .then(() => { });
    }

    public stepIn(): Promise<void> {
        this._expectingResumedEvent = true;
        return this._chromeConnection.debugger_stepIn()
            .then(() => { });
    }

    public stepOut(): Promise<void> {
        this._expectingResumedEvent = true;
        return this._chromeConnection.debugger_stepOut()
            .then(() => { });
    }

    public pause(): Promise<void> {
        return this._chromeConnection.debugger_pause()
            .then(() => { });
    }

    public stackTrace(args: DebugProtocol.StackTraceArguments): IStackTraceResponseBody {
        // Only process at the requested number of frames, if 'levels' is specified
        let stack = this._currentStack;
        if (args.levels) {
            stack = this._currentStack.filter((_, i) => i < args.levels);
        }

        const stackFrames: DebugProtocol.StackFrame[] = stack
            .map(({ location, functionName }, i: number) => {
                const line = location.lineNumber;
                const column = location.columnNumber;
                const script = this._scriptsById.get(location.scriptId);

                try {
                    // When the script has a url and isn't one we're ignoring, send the name and path fields. PathTransformer will
                    // attempt to resolve it to a script in the workspace. Otherwise, send the name and sourceReference fields.
                    const source: DebugProtocol.Source =
                        script && !this.shouldIgnoreScript(script) ?
                            {
                                name: path.basename(script.url),
                                path: script.url,
                                sourceReference: this._sourceHandles.create({ scriptId: script.scriptId })
                            } :
                            {
                                // Name should be undefined, work around VS Code bug 20274
                                name: 'eval: ' + location.scriptId,
                                path: ChromeDebugAdapter.PLACEHOLDER_URL_PROTOCOL + location.scriptId,
                                sourceReference: this._sourceHandles.create({ scriptId: location.scriptId })
                            };

                    // If the frame doesn't have a function name, it's either an anonymous function
                    // or eval script. If its source has a name, it's probably an anonymous function.
                    const frameName = functionName || (script.url ? '(anonymous function)' : '(eval code)');
                    return {
                        id: i,
                        name: frameName,
                        source,
                        line: line,
                        column
                    };
                } catch (e) {
                    // Some targets such as the iOS simulator behave badly and return nonsense callFrames.
                    // In these cases, return a dummy stack frame
                    return {
                        id: i,
                        name: 'Unknown',
                        source: {name: 'eval:Unknown', path: ChromeDebugAdapter.PLACEHOLDER_URL_PROTOCOL + 'Unknown'},
                        line,
                        column
                    };
                }
            });

        const stackTraceResponse = { stackFrames };
        this._pathTransformer.stackTraceResponse(stackTraceResponse);
        this._sourceMapTransformer.stackTraceResponse(stackTraceResponse);
        this._lineNumberTransformer.stackTraceResponse(stackTraceResponse);

        return stackTraceResponse;
    }

    public scopes(args: DebugProtocol.ScopesArguments): IScopesResponseBody {
        const currentFrame = this._currentStack[args.frameId];
        const scopes = currentFrame.scopeChain.map((scope: Chrome.Debugger.Scope, i: number) => {
            // The first scope should include 'this'. Keep the RemoteObject reference for use by the variables request
            const thisObj = i === 0 ? currentFrame['this'] : undefined;
            const variablesReference = this._variableHandles.create(new ScopeContainer(currentFrame.callFrameId, i, scope.object.objectId, thisObj));

            return <DebugProtocol.Scope>{
                name: scope.type.substr(0, 1).toUpperCase() + scope.type.substr(1), // Take Chrome's scope, uppercase the first letter
                variablesReference,
                expensive: scope.type === 'global'
            };
        });

        return { scopes };
    }

    public variables(args: DebugProtocol.VariablesArguments): Promise<IVariablesResponseBody> {
        const handle = this._variableHandles.get(args.variablesReference);
        if (!handle) {
            return Promise.resolve<IVariablesResponseBody>(undefined);
        }

        // TODO create Container for this special exception scope
        // If this is the special marker for an exception value, create a fake property descriptor so the usual route can be used
        if (handle.objectId === ChromeDebugAdapter.EXCEPTION_VALUE_ID) {
            const excValuePropDescriptor: Chrome.Runtime.PropertyDescriptor = <any>{ name: 'exception', value: this._exceptionValueObject };
            return this.propertyDescriptorToVariable(excValuePropDescriptor)
                .then(variable => ({ variables: [variable]}));
        }

        return handle.expand(this, args.filter, args.start, args.count).then(variables => {
            return { variables };
        });
    }

    public propertyDescriptorToVariable(propDesc: Chrome.Runtime.PropertyDescriptor, owningObjectId?: string): Promise<DebugProtocol.Variable> {
        if (propDesc.get) {
            const grabGetterValue = 'function remoteFunction(propName) { return this[propName]; }';
            return this._chromeConnection.runtime_callFunctionOn(owningObjectId, grabGetterValue, [{ value: propDesc.name }]).then(response => {
                if (response.error) {
                    logger.error('Error evaluating getter - ' + response.error.toString());
                    return { name: propDesc.name, value: response.error.toString(), variablesReference: 0 };
                } else if (response.result.exceptionDetails) {
                    // Not an error, getter could be `get foo() { throw new Error('bar'); }`
                    const exceptionDetails = response.result.exceptionDetails;
                    logger.log('Exception thrown evaluating getter - ' + JSON.stringify(exceptionDetails.exception));
                    return { name: propDesc.name, value: response.result.exceptionDetails.exception.description, variablesReference: 0 };
                } else {
                    return this.remoteObjectToVariable(propDesc.name, response.result.result);
                }
            });
        } else if (propDesc.set) {
            // setter without a getter, unlikely
            return Promise.resolve({ name: propDesc.name, value: 'setter', variablesReference: 0 });
        } else {
            // Non getter/setter
            return this.internalPropertyDescriptorToVariable(propDesc);
        }
    }

    public getVariablesForObjectId(objectId: string, filter?: string, start?: number, count?: number): Promise<DebugProtocol.Variable[]> {
        if (typeof start === 'number' && typeof count === 'number') {
            return this.getFilteredVariablesForObjectId(objectId, filter, start, count);
        }

        return Promise.all([
            // Need to make two requests to get all properties
            this._chromeConnection.runtime_getProperties(objectId, /*ownProperties=*/false, /*accessorPropertiesOnly=*/true, /*generatePreview=*/true),
            this._chromeConnection.runtime_getProperties(objectId, /*ownProperties=*/true, /*accessorPropertiesOnly=*/false, /*generatePreview=*/true)
        ]).then(getPropsResponses => {
            // Sometimes duplicates will be returned - merge all descriptors by name
            const propsByName = new Map<string, Chrome.Runtime.PropertyDescriptor>();
            const internalPropsByName = new Map<string, Chrome.Runtime.InternalPropertiesDescriptor>();
            getPropsResponses.forEach(response => {
                if (!response.error) {
                    response.result.result.forEach(propDesc =>
                        propsByName.set(propDesc.name, propDesc));

                    if (response.result.internalProperties) {
                        response.result.internalProperties.forEach(internalProp => {
                            internalPropsByName.set(internalProp.name, internalProp);
                        });
                    }
                }
            });

            // Convert Chrome prop descriptors to DebugProtocol vars
            const variables: Promise<DebugProtocol.Variable>[] = [];
            propsByName.forEach(propDesc => variables.push(this.propertyDescriptorToVariable(propDesc, objectId)));
            internalPropsByName.forEach(internalProp => variables.push(Promise.resolve(this.internalPropertyDescriptorToVariable(internalProp))));

            return Promise.all(variables);
        }).then(variables => {
            // After retrieving all props, apply the filter
            if (filter === 'indexed' || filter === 'named') {
                const keepIndexed = filter === 'indexed';
                variables = variables.filter(variable => keepIndexed === isIndexedPropName(variable.name));
            }

            // Sort all variables properly
            return variables.sort((var1, var2) => ChromeUtils.compareVariableNames(var1.name, var2.name));
        });
    }

    private internalPropertyDescriptorToVariable(propDesc: Chrome.Runtime.InternalPropertiesDescriptor): Promise<DebugProtocol.Variable> {
        return this.remoteObjectToVariable(propDesc.name, propDesc.value);
    }

    private getFilteredVariablesForObjectId(objectId: string, filter: string, start: number, count: number): Promise<DebugProtocol.Variable[]> {
        // No ES6, in case we talk to an old runtime
        const getIndexedVariablesFn = `
            function getIndexedVariables(start, count) {
                var result = [];
                for (var i = start; i < (start + count); i++) result[i] = this[i];
                return result;
            }`;
        // TODO order??
        const getNamedVariablesFn = `
            function getNamedVariablesFn(start, count) {
                var result = [];
                var ownProps = Object.getOwnProperties(this);
                for (var i = start; i < (start + count); i++) result[i] = ownProps[i];
                return result;
            }`;

        const getVarsFn = filter === 'indexed' ? getIndexedVariablesFn : getNamedVariablesFn;
        return this._chromeConnection.runtime_callFunctionOn(objectId, getVarsFn, [{ value: start }, { value: count }], /*silent=*/true).then(evalResponse => {
            if (evalResponse.error) {
                return Promise.reject(errors.errorFromEvaluate(evalResponse.error.message));
            } else if (evalResponse.result.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(evalResponse.result.exceptionDetails);
                return Promise.reject(errors.errorFromEvaluate(errMsg));
            } else {
                return this.getVariablesForObjectId(evalResponse.result.result.objectId, filter);
            }
        });
    }

    public source(args: DebugProtocol.SourceArguments): Promise<ISourceResponseBody> {
        const handle = this._sourceHandles.get(args.sourceReference);
        if (!handle) {
            return Promise.reject(errors.sourceRequestIllegalHandle());
        }

        // Have inlined content?
        if (handle.contents) {
            return Promise.resolve({
                content: handle.contents
            });
        }

        // If not, should have scriptId
        return this._chromeConnection.debugger_getScriptSource(handle.scriptId).then(chromeResponse => {
            return {
                content: chromeResponse.result.scriptSource,
                mimeType: 'text/javascript'
            };
        });
    }

    public threads(): IThreadsResponseBody {
        return {
            threads: [
                {
                    id: ChromeDebugAdapter.THREAD_ID,
                    name: 'Thread ' + ChromeDebugAdapter.THREAD_ID
                }
            ]
        };
    }

    public evaluate(args: DebugProtocol.EvaluateArguments): Promise<IEvaluateResponseBody> {
        let evalPromise: Promise<any>;
        if (this.paused) {
            const callFrameId = this._currentStack[args.frameId].callFrameId;
            evalPromise = this._chromeConnection.debugger_evaluateOnCallFrame(callFrameId, args.expression);
        } else {
            evalPromise = this._chromeConnection.runtime_evaluate(args.expression);
        }

        return evalPromise.then(evalResponse => {
            if (evalResponse.result.wasThrown) {
                const evalResult = evalResponse.result;
                let errorMessage = 'Error';
                if (evalResult.exceptionDetails) {
                    errorMessage = evalResult.exceptionDetails.text;
                } else if (evalResult.result && evalResult.result.description) {
                    errorMessage = evalResult.result.description;
                }
                return utils.errP(errorMessage);
            }

            // Convert to a Variable object then just copy the relevant fields off
            return this.remoteObjectToVariable('', evalResponse.result.result);
        }).then(variable => {
            return <IEvaluateResponseBody>{
                result: variable.value,
                variablesReference: variable.variablesReference,
                indexedVariables: variable.indexedVariables,
                namedVariables: variable.namedVariables
            };
        });
    }

    public setVariable(args: DebugProtocol.SetVariableArguments): Promise<ISetVariableResponseBody> {
        const handle = this._variableHandles.get(args.variablesReference);
        if (!handle) {
            return Promise.reject(errors.setValueNotSupported());
        }

        return handle.setValue(this, args.name, args.value)
            .then(value => ({ value }));
    }

    public _setVariableValue(frameId: string, scopeIndex: number, name: string, value: string): Promise<string> {
        let evalResultObject: Chrome.Runtime.RemoteObject;
        return this._chromeConnection.debugger_evaluateOnCallFrame(frameId, value, undefined, undefined, /*silent=*/true).then(evalResponse => {
            if (evalResponse.error) {
                return Promise.reject(errors.errorFromEvaluate(evalResponse.error.message));
            } else if (evalResponse.result.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(evalResponse.result.exceptionDetails);
                return Promise.reject(errors.errorFromEvaluate(errMsg));
            } else {
                evalResultObject = evalResponse.result.result;
                const newVal = ChromeUtils.remoteObjectToCallArgument(evalResultObject);
                return this._chromeConnection.debugger_setVariableValue(frameId, scopeIndex, name, newVal);
            }
        })
        // Temporary, Microsoft/vscode#12019
        .then(setVarResponse => ChromeUtils.remoteObjectToValue(evalResultObject).value);
    }

    public _setPropertyValue(objectId: string, propName: string, value: string): Promise<string> {
        return this._chromeConnection.runtime_callFunctionOn(objectId, `function() { return this["${propName}"] = ${value} }`, undefined, /*silent=*/true).then(response => {
            if (response.error) {
                return Promise.reject(errors.errorFromEvaluate(response.error.message));
            } else if (response.result.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(response.result.exceptionDetails);
                return Promise.reject(errors.errorFromEvaluate(errMsg));
            } else {
                // Temporary, Microsoft/vscode#12019
                return ChromeUtils.remoteObjectToValue(response.result.result).value;
            }
        });
    }

    private remoteObjectToVariable(name: string, object: Chrome.Runtime.RemoteObject, stringify = true): Promise<DebugProtocol.Variable> {
        let value = '';

        if (object) {
            if (object.type === 'object') {
                if (object.subtype === 'null') {
                    value = 'null';
                } else {
                    return this.createObjectVariable(name, object);
                }
            } else if (object.type === 'undefined') {
                value = 'undefined';
            } else if (object.type === 'function') {
                return Promise.resolve(this.createFunctionVariable(name, object));
            } else {
                // The value is a primitive value, or something that has a description (not object, primitive, or undefined). And force to be string
                if (typeof object.value === 'undefined') {
                    value = object.description;
                } else if (object.type === 'number') {
                    // 3 => "3"
                    // "Infinity" => "Infinity" (not stringified)
                    value = object.value + '';
                } else {
                    value = stringify ? JSON.stringify(object.value) : object.value;
                }
            }
        }

        return Promise.resolve(<DebugProtocol.Variable>{
            name,
            value,
            variablesReference: 0
        });
    }

    public createFunctionVariable(name: string, object: Chrome.Runtime.RemoteObject): DebugProtocol.Variable {
        let value: string;
        const firstBraceIdx = object.description.indexOf('{');
        if (firstBraceIdx >= 0) {
            value = object.description.substring(0, firstBraceIdx) + '{ … }';
        } else {
            const firstArrowIdx = object.description.indexOf('=>');
            value = firstArrowIdx >= 0 ?
                object.description.substring(0, firstArrowIdx + 2) + ' …' :
                object.description;
        }

        return { name, value, variablesReference: 0 };
    }

    public createObjectVariable(name: string, object: Chrome.Runtime.RemoteObject, stringify?: boolean): Promise<DebugProtocol.Variable> {
        let propCountP: Promise<IPropCount>;
        if (object.subtype === 'array' || object.subtype === 'typedarray') {
            if (object.preview && !object.preview.overflow) {
                propCountP = Promise.resolve(this.getArrayNumPropsByPreview(object));
            } else {
                propCountP = this.getArrayNumPropsByEval(object.objectId);
            }
        } else {
            if (object.preview && !object.preview.overflow) {
                propCountP = Promise.resolve(this.getObjectNumPropsByPreview(object));
            } else {
                propCountP = this.getObjectNumPropsByEval(object.objectId);
            }
        }

        const value = object.description;
        const variablesReference = this._variableHandles.create(new PropertyContainer(object.objectId));
        return propCountP.then(({ indexedVariables, namedVariables }) => (<DebugProtocol.Variable>{
            name,
            value,
            variablesReference,
            indexedVariables,
            namedVariables
        }));
    }

    private getArrayNumPropsByEval(objectId: string): Promise<IPropCount> {
        const getNumPropsFn = `function() {return [this.length, Object.keys(this).length - this.length ];}`;
        return this._chromeConnection.runtime_callFunctionOn(objectId, getNumPropsFn, undefined, /*silent=*/true, /*returnByValue=*/true).then(response => {
            if (response.error) {
                return Promise.reject(errors.errorFromEvaluate(response.error.message));
            } else if (response.result.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(response.result.exceptionDetails);
                return Promise.reject(errors.errorFromEvaluate(errMsg));
            } else {
                const resultProps = response.result.result.value;
                if (resultProps.length !== 2) {
                    return Promise.reject(errors.errorFromEvaluate("Did not get expected props, got " + JSON.stringify(resultProps)));
                }

                return { indexedVariables: resultProps[0], namedVariables: resultProps[1] };
            }
        });
    }

    private getArrayNumPropsByPreview(object: Chrome.Runtime.RemoteObject): IPropCount {
        let indexedVariables = 0;
        let namedVariables = 0;
        object.preview.properties.forEach(prop => isIndexedPropName(prop.name) ? indexedVariables++ : namedVariables++);
        return { indexedVariables, namedVariables };
    }

    private getObjectNumPropsByEval(objectId: string): Promise<IPropCount> {
        // TODO - counting and order?
        const getNumPropsFn = `function() {
            function isIndexed(name) { return !isNaN(parseInt(name, 10)); }
            function isNamed(name) { return isNaN(parseInt(name, 10)); }

            var keys = Object.keys(this);
            return [keys.filter(isIndexed).length, keys.filter(isNamed).length];
        }`;
        return this._chromeConnection.runtime_callFunctionOn(objectId, getNumPropsFn, undefined, /*silent=*/true, /*returnByValue=*/true).then(response => {
            if (response.error) {
                return Promise.reject(errors.errorFromEvaluate(response.error.message));
            } else if (response.result.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(response.result.exceptionDetails);
                return Promise.reject(errors.errorFromEvaluate(errMsg));
            } else {
                return { indexedVariables: response.result.result.value[0], namedVariables: response.result.result.value[1] };
            }
        });
    }

    private getObjectNumPropsByPreview(object: Chrome.Runtime.RemoteObject): IPropCount {
        let namedVariables = object.preview.properties.length;
        return { indexedVariables: 0, namedVariables };
    }

    private shouldIgnoreScript(script: Chrome.Debugger.Script): boolean {
        return script.isContentScript || script.isInternalScript || script.url.startsWith('extensions::') || script.url.startsWith('chrome-extension://');
    }
}
