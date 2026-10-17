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
     * (`document.modelContext`). Milestone 2: the workflows come from the agent workflow manifest Nova
     * publishes to the app's content bucket (`agentWorkflows: { manifestUrl }`), fetched on ready,
     * identify and urlChanged, revalidated by the document `version`, with the last good copy kept.
     * One `search_app` tool, registered under a single AbortController and re-registered when the URL
     * or the manifest changes. The manifest is data only: nothing in it is evaluated, no remote code
     * is loaded, and the DOM is never touched.
     */
    var CONFIG_NAME = 'agentWorkflows';
    var LOG_PREFIX = '[Agent Workflows]';
    var MAX_RESULTS = 5;
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
    // Kept identical to nova `api/src/artifacts/agent-manifest/agent-workflow-ranking.ts`, so a query
    // ranks the same way in the page and on the server. Change both together.
    var STOP_WORDS = {};
    var STOP_WORD_LIST = 'a an and as at be by can do for from how i in is it me my of on or the to up want where with you'.split(' ');
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
    // The shape search needs; anything else in the document is ignored, never trusted.
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
                kind: isString(step.kind) ? step.kind : undefined
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
    function AgentWorkflows() {
        var api;
        var log;
        var controller = null;
        var manifestUrl = null;
        var manifest = null;
        var pending = null;
        return {
            name: 'AgentWorkflows',
            initialize: initialize,
            teardown: teardown,
            getModelContext: getModelContext,
            registerTools: registerTools,
            refreshManifest: refreshManifest,
            getManifest: getManifest,
            searchApp: searchApp
        };
        function initialize(pendoGlobal, PluginAPI) {
            var _a, _b, _c;
            api = PluginAPI;
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
            manifest = null;
            manifestUrl = null;
            pending = null;
            api = null;
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
            var tool = __assign(__assign({}, SEARCH_APP_TOOL), { execute: executeSearchApp });
            Promise.resolve()
                .then(function () { return modelContext.registerTool(tool, { signal: controller.signal }); })
                .then(function () {
                log.info("".concat(LOG_PREFIX, " registered tool ").concat(tool.name, " (manifest version ").concat(manifest.version, ") on ").concat(window.location.href));
            }, function (error) {
                log.error("".concat(LOG_PREFIX, " failed to register tool ").concat(tool.name, ":"), error);
            });
        }
        // Chrome before 155 handed tools JSON-stringified arguments, so accept both shapes.
        function executeSearchApp(input) {
            var args = input;
            if (typeof input === 'string') {
                try {
                    args = JSON.parse(input);
                }
                catch (e) {
                    args = { query: input };
                }
            }
            var query = (args && typeof args.query === 'string') ? args.query : '';
            var workflows = searchApp(query);
            log.info("".concat(LOG_PREFIX, " search_app(\"").concat(query, "\") -> ").concat(workflows.length, " workflow(s)"));
            return {
                content: [{ type: 'text', text: JSON.stringify({ workflows: workflows }) }]
            };
        }
        function searchApp(query) {
            var workflows = manifest ? manifest.workflows : [];
            if (tokenize(query).length === 0)
                return workflows.slice();
            return rankWorkflows(query, workflows)
                .slice(0, MAX_RESULTS)
                .map(function (hit) { return hit.workflow; });
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
