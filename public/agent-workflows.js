(function () {
    'use strict';

    /******************************************************************************
    Copyright (c) Microsoft Corporation.

    Permission to use, copy, modify, and/or distribute this software for any
    purpose with or without fee is hereby granted.

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
    REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
    AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
    INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
    LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
    OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
    PERFORMANCE OF THIS SOFTWARE.
    ***************************************************************************** */
    /* global Reflect, Promise, SuppressedError, Symbol, Iterator */


    var __assign = function() {
        __assign = Object.assign || function __assign(t) {
            for (var s, i = 1, n = arguments.length; i < n; i++) {
                s = arguments[i];
                for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
            }
            return t;
        };
        return __assign.apply(this, arguments);
    };

    typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
        var e = new Error(message);
        return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
    };

    /*
     * Agent Workflows Plugin
     *
     * Independent plugin that exposes the application's workflows to browser agents through WebMCP
     * (`document.modelContext`). The workflows come from the agent workflow manifest Nova publishes to
     * the app's content bucket (`agentWorkflows: { manifestUrl }`), fetched on ready, identify and
     * urlChanged, revalidated by the document `version`, with the last good copy kept.
     *
     * Tools, all registered under a single AbortController and re-registered when the URL or the
     * manifest changes: `search_app` ranks workflows for a query, `navigate_to_workflow` stores the
     * chosen workflow and loads its entry path on this origin, `get_workflow_context` reports where
     * the visitor is in the stored workflow, and `reveal_step` scrolls to and outlines the next step's
     * element. Every invocation records an "Agent Tool Invoked" track event.
     *
     * The manifest is data only: nothing in it is evaluated and no remote code is loaded. Page rules
     * are only tested against the URL and selectors are only queried.
     */
    var CONFIG_NAME = 'agentWorkflows';
    var LOG_PREFIX = '[Agent Workflows]';
    var MAX_RESULTS = 5;
    var STORAGE_KEY = 'agentWorkflow';
    var TRACK_EVENT_NAME = 'Agent Tool Invoked';
    var REVEAL_OUTLINE_ID = 'pendo-agent-workflows-reveal';
    var REVEAL_OUTLINE_MS = 4000;
    var REVEAL_OUTLINE_STYLE = 'position:fixed;box-sizing:border-box;border:2px solid #FF4876;border-radius:2px;' +
        'box-shadow:0 0 0 2px rgba(255,72,118,0.35);pointer-events:none;z-index:2147483644;';
    var SEARCH_APP_TOOL = {
        name: 'search_app',
        description: 'Search the workflows this application supports. Returns the best matching workflows with ' +
            'what each one does, who it is for, what it needs, and the path where it starts. ' +
            'An empty query lists every workflow.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'What the user wants to do, in their own words.'
                }
            },
            required: ['query']
        },
        annotations: {
            readOnlyHint: true
        }
    };
    var NAVIGATE_TOOL = {
        name: 'navigate_to_workflow',
        description: 'Start a workflow by navigating this tab to the page where it begins. This loads a new page, ' +
            'so the call returns nothing useful and this page\'s tools are replaced. Ask the user before calling it. ' +
            'After the new page loads, call get_workflow_context to find out which step the user is on and what to do next.',
        inputSchema: {
            type: 'object',
            properties: {
                workflowId: {
                    type: 'string',
                    description: 'The id of a workflow returned by search_app.'
                }
            },
            required: ['workflowId']
        },
        annotations: {
            consequentialHint: true
        }
    };
    var CONTEXT_TOOL = {
        name: 'get_workflow_context',
        description: 'Describe where the user is in a workflow on the current page: the workflow\'s purpose, who it is ' +
            'for and what it needs, the step the current page corresponds to, the next step with its hint and whether ' +
            'its element is on this page, and which actions are available next (navigate, reveal). ' +
            'Defaults to the workflow started with navigate_to_workflow.',
        inputSchema: {
            type: 'object',
            properties: {
                workflowId: {
                    type: 'string',
                    description: 'A workflow id from search_app. Omit it to use the workflow in progress.'
                }
            }
        },
        annotations: {
            readOnlyHint: true
        }
    };
    var REVEAL_TOOL = {
        name: 'reveal_step',
        description: 'Scroll the next step\'s element into view and outline it for a few seconds so the user can ' +
            'find it. Only works when get_workflow_context reports the next step\'s element as present and visible. ' +
            'Does not click or change anything.',
        inputSchema: {
            type: 'object',
            properties: {
                workflowId: {
                    type: 'string',
                    description: 'A workflow id from search_app. Omit it to use the workflow in progress.'
                }
            }
        },
        annotations: {
            idempotentHint: true
        }
    };
    var TOOLS = [SEARCH_APP_TOOL, NAVIGATE_TOOL, CONTEXT_TOOL, REVEAL_TOOL];
    // Kept identical to nova `api/src/artifacts/agent-manifest/agent-workflow-ranking.ts`, so a query
    // ranks the same way in the page and on the server. Change both together.
    var STOP_WORDS = {};
    var STOP_WORD_LIST = ('a an and as at be by can do for from how i in is it me my of on or the to up want where with you ' +
        'anything app available did does here page site something that there these thing things this those what which who why').split(' ');
    for (var i = 0; i < STOP_WORD_LIST.length; i++)
        STOP_WORDS[STOP_WORD_LIST[i]] = true;
    function stem(word) {
        if (word.length <= 3)
            return word;
        if (word.slice(-3) === 'ies')
            return "".concat(word.slice(0, -3), "y");
        if (word.slice(-3) === 'ing' && word.length > 5)
            return word.slice(0, -3);
        if (word.slice(-2) === 'ed' && word.length > 4)
            return word.slice(0, -2);
        if (word.slice(-2) === 'es' && word.length > 4)
            return word.slice(0, -2);
        if (word.slice(-1) === 's' && word.slice(-2) !== 'ss')
            return word.slice(0, -1);
        return word;
    }
    function tokenize(text) {
        return String(text || '')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(function (word) { return word.length > 1 && !STOP_WORDS[word]; })
            .map(stem);
    }
    function haystackOf(workflow) {
        var parts = [workflow.name, workflow.description].concat(workflow.intents);
        for (var i = 0; i < workflow.steps.length; i++) {
            parts.push(workflow.steps[i].name, workflow.steps[i].hint || '');
        }
        return tokenize(parts.join(' '));
    }
    function unique(terms) {
        var seen = {};
        return terms.filter(function (term) {
            if (seen[term])
                return false;
            seen[term] = true;
            return true;
        });
    }
    function matches(word, term) {
        return word.indexOf(term) === 0;
    }
    function rankWorkflows(query, workflows) {
        var terms = unique(tokenize(query));
        if (terms.length === 0)
            return [];
        var ranked = [];
        var _loop_1 = function (i) {
            var workflow = workflows[i];
            var words = haystackOf(workflow);
            var matched = terms.filter(function (term) { return words.some(function (word) { return matches(word, term); }); }).length;
            if (matched === 0)
                return "continue";
            var hits = words.filter(function (word) { return terms.some(function (term) { return matches(word, term); }); }).length;
            ranked.push({ workflow: workflow, score: matched / terms.length, hits: hits });
        };
        for (var i = 0; i < workflows.length; i++) {
            _loop_1(i);
        }
        return ranked.sort(function (a, b) { return b.score - a.score || b.hits - a.hits; });
    }
    function isString(value) {
        return typeof value === 'string';
    }
    function stringList(value) {
        return Array.isArray(value) ? value.filter(isString) : [];
    }
    // The shape the tools need; anything else in the document is ignored, never trusted.
    function parseWorkflow(entry) {
        if (!entry || !isString(entry.id) || !isString(entry.name) || !isString(entry.entryPath))
            return null;
        var steps = Array.isArray(entry.steps) ? entry.steps : [];
        return {
            id: entry.id,
            version: typeof entry.version === 'number' ? entry.version : 0,
            name: entry.name,
            description: isString(entry.description) ? entry.description : '',
            intents: stringList(entry.intents),
            persona: isString(entry.persona) ? entry.persona : undefined,
            prerequisites: stringList(entry.prerequisites),
            outcomes: stringList(entry.outcomes),
            entryPath: entry.entryPath,
            requiredSegmentFlag: isString(entry.requiredSegmentFlag) ? entry.requiredSegmentFlag : undefined,
            steps: steps
                .filter(function (step) { return step && isString(step.name); })
                .map(function (step) { return ({
                index: typeof step.index === 'number' ? step.index : 0,
                name: step.name,
                hint: isString(step.hint) ? step.hint : undefined,
                kind: isString(step.kind) ? step.kind : undefined,
                urlPatterns: stringList(step.urlPatterns),
                cssSelector: isString(step.cssSelector) ? step.cssSelector : undefined,
                trackEventName: isString(step.trackEventName) ? step.trackEventName : undefined
            }); })
        };
    }
    function parseManifest(document) {
        if (!document || typeof document !== 'object' || typeof document.version !== 'number' ||
            !Array.isArray(document.workflows)) {
            return null;
        }
        return {
            appId: isString(document.appId) ? document.appId : undefined,
            version: document.version,
            generatedAt: isString(document.generatedAt) ? document.generatedAt : undefined,
            workflows: document.workflows.map(parseWorkflow).filter(Boolean)
        };
    }
    // Manifest urlPatterns are Pendo page rules ("//*/account/orders/*"), not regexes: a leading "//"
    // stands for any scheme, "**" spans path segments and "*" matches within one. testPageRule takes a
    // regex, so each rule is converted once here; a query string or fragment never affects the match.
    function pageRuleToRegex(rule) {
        var pattern = String(rule);
        var prefix = '^';
        if (pattern.indexOf('//') === 0) {
            pattern = pattern.slice(2);
            prefix += '[a-zA-Z][a-zA-Z0-9+.-]*://';
        }
        var body = pattern.split('**')
            .map(function (span) { return span.replace(/[.+?^${}()|[\]\\/]/g, '\\$&').replace(/\*/g, '[^/]*'); })
            .join('.*');
        return "".concat(prefix).concat(body, "/?(?:[?#].*)?$");
    }
    function stepSummary(step) {
        return step ? { index: step.index, name: step.name, hint: step.hint, kind: step.kind } : null;
    }
    function textResult(payload, isError) {
        var result = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
        if (isError)
            result.isError = true;
        return result;
    }
    // Chrome before 155 handed tools JSON-stringified arguments, so accept both shapes.
    function parseArguments(input, fallbackKey) {
        if (input && typeof input === 'object')
            return input;
        if (typeof input !== 'string')
            return {};
        try {
            var parsed = JSON.parse(input);
            return parsed && typeof parsed === 'object' ? parsed : {};
        }
        catch (e) {
            var fallback = {};
            if (fallbackKey)
                fallback[fallbackKey] = input;
            return fallback;
        }
    }
    function AgentWorkflows() {
        var api;
        var pendo;
        var log;
        var controller = null;
        var manifestUrl = null;
        var manifest = null;
        var pending = null;
        var revealOutline = null;
        var revealTimer = null;
        return {
            name: 'AgentWorkflows',
            initialize: initialize,
            teardown: teardown,
            getModelContext: getModelContext,
            registerTools: registerTools,
            refreshManifest: refreshManifest,
            getManifest: getManifest,
            searchApp: searchApp,
            navigateToWorkflow: navigateToWorkflow,
            getWorkflowContext: getWorkflowContext,
            revealStep: revealStep,
            getStoredWorkflow: getStoredWorkflow
        };
        function initialize(pendoGlobal, PluginAPI) {
            var _a, _b, _c;
            api = PluginAPI;
            pendo = pendoGlobal;
            log = api.log;
            var ConfigReader = api.ConfigReader;
            ConfigReader.addOption(CONFIG_NAME, [
                ConfigReader.sources.PENDO_CONFIG_SRC,
                ConfigReader.sources.SNIPPET_SRC
            ]);
            var config = ConfigReader.get(CONFIG_NAME);
            if (!config) {
                log.info("".concat(LOG_PREFIX, " disabled: no ").concat(CONFIG_NAME, " option"));
                return;
            }
            if (!isString(config.manifestUrl) || !config.manifestUrl) {
                log.info("".concat(LOG_PREFIX, " disabled: ").concat(CONFIG_NAME, ".manifestUrl is not set"));
                return;
            }
            if (!getModelContext()) {
                log.info("".concat(LOG_PREFIX, " disabled: WebMCP is not available in this browser"));
                return;
            }
            if (typeof window.fetch !== 'function') {
                log.info("".concat(LOG_PREFIX, " disabled: fetch is not available in this browser"));
                return;
            }
            manifestUrl = config.manifestUrl;
            /**
            * The agent workflow in progress in this browser: `{ workflowId, startedAt }`, written by the
            * navigate_to_workflow WebMCP tool and read back by get_workflow_context after the navigation.
            *
            * @name _pendo_agentWorkflow
            * @category Cookies/localStorage
            * @access public
            * @label STORAGE_KEY
            */
            api.agentStorage.registry.addLocal(STORAGE_KEY);
            (_a = api.Events.ready) === null || _a === void 0 ? void 0 : _a.on(refreshManifest);
            (_b = api.Events.identify) === null || _b === void 0 ? void 0 : _b.on(refreshManifest);
            (_c = api.Events.urlChanged) === null || _c === void 0 ? void 0 : _c.on(onUrlChanged);
            refreshManifest();
        }
        function teardown() {
            var _a, _b, _c;
            (_a = api === null || api === void 0 ? void 0 : api.Events.ready) === null || _a === void 0 ? void 0 : _a.off(refreshManifest);
            (_b = api === null || api === void 0 ? void 0 : api.Events.identify) === null || _b === void 0 ? void 0 : _b.off(refreshManifest);
            (_c = api === null || api === void 0 ? void 0 : api.Events.urlChanged) === null || _c === void 0 ? void 0 : _c.off(onUrlChanged);
            abortRegistration();
            clearRevealOutline();
            manifest = null;
            manifestUrl = null;
            pending = null;
            api = null;
            pendo = null;
            log = null;
        }
        function getModelContext() {
            if (!window.isSecureContext)
                return null;
            var modelContext = document.modelContext || window.navigator.modelContext;
            if (!modelContext || typeof modelContext.registerTool !== 'function')
                return null;
            return modelContext;
        }
        function getManifest() {
            return manifest;
        }
        function onUrlChanged() {
            if (manifest)
                registerTools();
            refreshManifest();
        }
        // One in-flight fetch at a time; a failed or malformed response keeps the last good copy.
        function refreshManifest() {
            if (!manifestUrl)
                return Promise.resolve(manifest);
            if (pending)
                return pending;
            var requestedFrom = manifestUrl;
            pending = window.fetch(requestedFrom, { credentials: 'omit', mode: 'cors' })
                .then(function (response) {
                if (!response.ok)
                    throw new Error("HTTP ".concat(response.status));
                return response.json();
            })
                .then(function (document) {
                if (!api || manifestUrl !== requestedFrom)
                    return manifest;
                var parsed = parseManifest(document);
                if (!parsed)
                    throw new Error('manifest is not the expected shape');
                if (manifest && manifest.version === parsed.version) {
                    log.info("".concat(LOG_PREFIX, " manifest unchanged at version ").concat(parsed.version));
                    return manifest;
                }
                manifest = parsed;
                log.info("".concat(LOG_PREFIX, " manifest version ").concat(parsed.version, ": ").concat(parsed.workflows.length, " workflow(s)"));
                registerTools();
                return manifest;
            })["catch"](function (error) {
                if (log) {
                    log.warn("".concat(LOG_PREFIX, " manifest fetch failed, keeping ").concat(manifest ? "version ".concat(manifest.version) : 'nothing', ":"), error);
                }
                return manifest;
            })
                .then(function (result) {
                pending = null;
                return result;
            });
            return pending;
        }
        function abortRegistration() {
            if (!controller)
                return;
            controller.abort();
            controller = null;
        }
        function registerTools() {
            var modelContext = getModelContext();
            if (!modelContext || !manifest)
                return;
            abortRegistration();
            controller = new AbortController();
            var signal = controller.signal;
            var executors = {
                search_app: executeSearchApp,
                navigate_to_workflow: executeNavigate,
                get_workflow_context: executeContext,
                reveal_step: executeReveal
            };
            var _loop_2 = function (i) {
                var tool = __assign(__assign({}, TOOLS[i]), { execute: executors[TOOLS[i].name] });
                Promise.resolve()
                    .then(function () { return modelContext.registerTool(tool, { signal: signal }); })
                    .then(function () {
                    if (!signal.aborted) {
                        log.info("".concat(LOG_PREFIX, " registered tool ").concat(tool.name, " (manifest version ").concat(manifest.version, ") on ").concat(window.location.href));
                    }
                }, function (error) {
                    log.error("".concat(LOG_PREFIX, " failed to register tool ").concat(tool.name, ":"), error);
                });
            };
            for (var i = 0; i < TOOLS.length; i++) {
                _loop_2(i);
            }
        }
        function recordInvocation(tool, workflowId, outcome) {
            api.analytics.collectEvent('track', { tool: tool, workflowId: workflowId || null, outcome: outcome }, undefined, TRACK_EVENT_NAME);
        }
        function findWorkflow(workflowId) {
            var workflows = manifest ? manifest.workflows : [];
            for (var i = 0; i < workflows.length; i++) {
                if (workflows[i].id === workflowId)
                    return workflows[i];
            }
            return null;
        }
        function getStoredWorkflow() {
            var raw = api.agentStorage.read(STORAGE_KEY);
            if (!raw)
                return null;
            var stored = raw;
            if (isString(raw)) {
                try {
                    stored = JSON.parse(raw);
                }
                catch (e) {
                    return null;
                }
            }
            return stored && isString(stored.workflowId) ? stored : null;
        }
        // The workflow a tool call refers to: the given id, or the stored one when no id is given.
        function resolveWorkflow(workflowId) {
            var stored = getStoredWorkflow();
            var id = isString(workflowId) && workflowId ? workflowId : (stored ? stored.workflowId : null);
            if (!id)
                return { error: 'no_workflow', stored: stored };
            var workflow = findWorkflow(id);
            if (!workflow)
                return { error: 'unknown_workflow', workflowId: id, stored: stored };
            return { workflow: workflow, stored: stored && stored.workflowId === id ? stored : null };
        }
        function executeSearchApp(input) {
            var args = parseArguments(input, 'query');
            var query = isString(args.query) ? args.query : '';
            var workflows = searchApp(query);
            log.info("".concat(LOG_PREFIX, " search_app(\"").concat(query, "\") -> ").concat(workflows.length, " workflow(s)"));
            recordInvocation(SEARCH_APP_TOOL.name, workflows.length ? workflows[0].id : null, workflows.length ? 'found' : 'no_match');
            return textResult({ workflows: workflows });
        }
        function searchApp(query) {
            var workflows = manifest ? manifest.workflows : [];
            if (tokenize(query).length === 0)
                return workflows.slice();
            return rankWorkflows(query, workflows)
                .slice(0, MAX_RESULTS)
                .map(function (hit) { return hit.workflow; });
        }
        function executeNavigate(input) {
            var args = parseArguments(input, 'workflowId');
            var result = navigateToWorkflow(args.workflowId);
            recordInvocation(NAVIGATE_TOOL.name, result.workflowId, result.outcome);
            log.info("".concat(LOG_PREFIX, " navigate_to_workflow(").concat(JSON.stringify(args.workflowId), ") -> ").concat(result.outcome));
            return textResult(result, result.outcome !== 'navigating');
        }
        // Only a root-relative path on this origin is ever loaded; anything else is refused unchanged.
        function navigateToWorkflow(workflowId) {
            var workflow = isString(workflowId) ? findWorkflow(workflowId) : null;
            if (!workflow) {
                return { outcome: 'unknown_workflow', workflowId: workflowId || null, message: 'No workflow has that id. Call search_app for the available workflows.' };
            }
            var entryPath = workflow.entryPath;
            var target = null;
            if (entryPath.indexOf('/') === 0 && entryPath.indexOf('//') !== 0 && entryPath.indexOf('\\') === -1) {
                try {
                    target = new URL(entryPath, window.location.origin);
                }
                catch (e) {
                    target = null;
                }
            }
            if (!target || target.origin !== window.location.origin) {
                log.warn("".concat(LOG_PREFIX, " refused to navigate to ").concat(JSON.stringify(entryPath), ": not a path on ").concat(window.location.origin));
                return { outcome: 'refused', workflowId: workflow.id, message: 'The workflow entry path is not a page on this site.' };
            }
            api.agentStorage.write(STORAGE_KEY, JSON.stringify({ workflowId: workflow.id, startedAt: new Date().toISOString() }));
            window.location.assign(target.href);
            return {
                outcome: 'navigating',
                workflowId: workflow.id,
                url: target.href,
                message: 'Navigating. Call get_workflow_context once the new page has loaded.'
            };
        }
        function executeContext(input) {
            var args = parseArguments(input, 'workflowId');
            var result = getWorkflowContext(args.workflowId);
            recordInvocation(CONTEXT_TOOL.name, result.workflowId, result.outcome);
            log.info("".concat(LOG_PREFIX, " get_workflow_context(").concat(JSON.stringify(args.workflowId), ") -> ").concat(result.outcome) +
                (result.workflow ? " step ".concat(result.currentStepIndex) : ''));
            return textResult(result, result.outcome === 'unknown_workflow');
        }
        function getWorkflowContext(workflowId) {
            var resolved = resolveWorkflow(workflowId);
            if (resolved.error === 'no_workflow') {
                return {
                    outcome: 'no_workflow',
                    workflowId: null,
                    workflow: null,
                    message: 'No workflow is in progress. Call search_app to find one, then navigate_to_workflow to start it.',
                    nextActions: ['navigate']
                };
            }
            if (resolved.error) {
                return { outcome: 'unknown_workflow', workflowId: resolved.workflowId, workflow: null, message: 'No workflow has that id. Call search_app for the available workflows.' };
            }
            var workflow = resolved.workflow, stored = resolved.stored;
            var steps = workflow.steps;
            var _a = locate(workflow), currentStep = _a.currentStep, nextStep = _a.nextStep, element = _a.element;
            var nextActions = [];
            if (!currentStep)
                nextActions.push('navigate');
            if (element && element.visible)
                nextActions.push('reveal');
            return {
                outcome: 'ok',
                workflowId: workflow.id,
                workflow: {
                    id: workflow.id,
                    name: workflow.name,
                    description: workflow.description,
                    persona: workflow.persona,
                    prerequisites: workflow.prerequisites,
                    outcomes: workflow.outcomes,
                    entryPath: workflow.entryPath,
                    startedAt: stored ? stored.startedAt : undefined,
                    stepCount: steps.length
                },
                url: window.location.href,
                currentStepIndex: currentStep ? currentStep.index : null,
                currentStep: stepSummary(currentStep),
                complete: !!currentStep && !nextStep,
                nextStep: nextStep ? __assign(__assign({}, stepSummary(nextStep)), { hasSelector: !!nextStep.cssSelector, selectorPresent: element ? element.present : null, selectorVisible: element ? element.visible : null }) : null,
                nextActions: nextActions
            };
        }
        function locate(workflow) {
            var steps = workflow.steps;
            var currentStep = findCurrentStep(steps);
            var position = currentStep ? steps.indexOf(currentStep) : -1;
            var nextStep = position + 1 < steps.length ? steps[position + 1] : null;
            var element = nextStep && nextStep.cssSelector ? findStepElement(nextStep) : null;
            return { currentStep: currentStep, nextStep: nextStep, element: element };
        }
        // The last page step whose rules match the current URL, so a deeper page beats its parent.
        function findCurrentStep(steps) {
            var current = null;
            for (var i = 0; i < steps.length; i++) {
                var step = steps[i];
                if (step.kind !== 'page' || !step.urlPatterns.length)
                    continue;
                var rules = step.urlPatterns.map(pageRuleToRegex);
                if (api.util.testPageRule(rules, undefined, { logger: log, context: 'agent workflow step', id: step.name })) {
                    current = step;
                }
            }
            return current;
        }
        // Selectors are only queried, through the same Sizzle the SDK uses for customer selectors.
        function findStepElement(step) {
            var found = [];
            try {
                found = pendo.Sizzle(step.cssSelector) || [];
            }
            catch (e) {
                log.warn("".concat(LOG_PREFIX, " invalid selector for step \"").concat(step.name, "\":"), e);
                return { present: false, visible: false, element: null };
            }
            var visibleElement = null;
            for (var i = 0; i < found.length && !visibleElement; i++) {
                if (isVisible(found[i]))
                    visibleElement = found[i];
            }
            return { present: found.length > 0, visible: !!visibleElement, element: visibleElement };
        }
        function isVisible(element) {
            return typeof pendo.isElementVisible === 'function' ? !!pendo.isElementVisible(element) : true;
        }
        function executeReveal(input) {
            var args = parseArguments(input, 'workflowId');
            var result = revealStep(args.workflowId);
            recordInvocation(REVEAL_TOOL.name, result.workflowId, result.outcome);
            log.info("".concat(LOG_PREFIX, " reveal_step(").concat(JSON.stringify(args.workflowId), ") -> ").concat(result.outcome));
            return textResult(result, result.outcome !== 'revealed');
        }
        function revealStep(workflowId) {
            var resolved = resolveWorkflow(workflowId);
            if (resolved.error)
                return getWorkflowContext(workflowId);
            var workflow = resolved.workflow;
            var _a = locate(workflow), nextStep = _a.nextStep, element = _a.element;
            var base = { workflowId: workflow.id, step: stepSummary(nextStep) };
            if (!nextStep) {
                return __assign(__assign({}, base), { outcome: 'complete', message: 'The workflow has no further step to reveal.' });
            }
            if (!element) {
                return __assign(__assign({}, base), { outcome: 'no_selector', message: 'The next step is a page, not an element. Follow its hint instead.' });
            }
            if (!element.present) {
                return __assign(__assign({}, base), { outcome: 'selector_absent', message: 'The next step\'s element is not on this page.' });
            }
            if (!element.visible) {
                return __assign(__assign({}, base), { outcome: 'selector_hidden', message: 'The next step\'s element is on this page but hidden.' });
            }
            showRevealOutline(element.element);
            return __assign(__assign({}, base), { outcome: 'revealed', message: "Scrolled to and outlined the element for \"".concat(nextStep.name, "\".") });
        }
        // A transient outline in the spirit of src/debugging/element-highlight.js: fixed, inert, and gone
        // after a few seconds. Nothing on the element itself changes.
        function showRevealOutline(element) {
            clearRevealOutline();
            if (typeof element.scrollIntoView === 'function') {
                element.scrollIntoView({ block: 'center', inline: 'center' });
            }
            var rect = element.getBoundingClientRect();
            var outline = document.createElement('div');
            outline.id = REVEAL_OUTLINE_ID;
            outline.setAttribute('style', "".concat(REVEAL_OUTLINE_STYLE, "top:").concat(rect.top, "px;left:").concat(rect.left, "px;width:").concat(rect.width, "px;height:").concat(rect.height, "px;"));
            (document.body || document.documentElement).appendChild(outline);
            revealOutline = outline;
            revealTimer = window.setTimeout(clearRevealOutline, REVEAL_OUTLINE_MS);
        }
        function clearRevealOutline() {
            if (revealTimer) {
                window.clearTimeout(revealTimer);
                revealTimer = null;
            }
            if (revealOutline) {
                if (revealOutline.parentNode)
                    revealOutline.parentNode.removeChild(revealOutline);
                revealOutline = null;
            }
        }
    }

    function addExtensionToGlobalNamespaceInstance(extensionConfig) {
        var globalKey;
        try {
            globalKey = document.currentScript.getAttribute('data-pendo-global-key') || 'pendo';
        }
        catch (e) {
            globalKey = 'pendo';
        }
        if (!window[globalKey]) {
            console.warn("".concat(extensionConfig.name, " failed to register - unable to find pendo global key \"").concat(globalKey, "\" on window"));
            return;
        }
        window[globalKey].addExtension && window[globalKey].addExtension(extensionConfig);
    }

    addExtensionToGlobalNamespaceInstance({
        name: 'AgentWorkflows',
        version: '0.1.0',
        type: 'agent',
        use: 'plugin',
        uri: AgentWorkflows()
    });

})();
