import { extension_settings, getContext } from '../../../extensions.js';
import { selected_world_info, world_names, loadWorldInfo, saveWorldInfo, createWorldInfoEntry } from '../../../world-info.js';
import { eventSource, event_types, generateRaw, saveSettingsDebounced } from '../../../../script.js';
import { registerSlashCommand } from '../../../slash-commands.js';

const EXTENSION_NAME = 'dynamic-lore';
const AUTO_APPROVE_THRESHOLD = 0.85;
const MAX_CONTEXT_MESSAGES = 12;

let proposalCounter = 0;
const pendingProposals = new Map();
let isAnalyzing = false;
let listenersRegistered = false;
let slashCommandRegistered = false;

function ensureSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {
            auto_analyze: true,
            analysis_interval: 5,
            auto_approve: false,
            target_world_info: '',
            message_count: 0,
        };
    }

    const settings = extension_settings[EXTENSION_NAME];
    settings.analysis_interval = Number(settings.analysis_interval) || 5;
    settings.analysis_interval = Math.max(1, Math.min(100, settings.analysis_interval));
    settings.message_count = Number(settings.message_count) || 0;
    settings.target_world_info = String(settings.target_world_info || '');
    settings.auto_analyze = !!settings.auto_analyze;
    settings.auto_approve = !!settings.auto_approve;

    return settings;
}

function notify(level, message) {
    if (window.toastr && typeof window.toastr[level] === 'function') {
        window.toastr[level](message, 'DynamicLore');
    } else {
        console.log(`[DynamicLore:${level}] ${message}`);
    }
}

function escapeHtml(input) {
    return String(input)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function normalizeKey(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeName(value) {
    return String(value || '').trim().toLowerCase();
}

function dedupeKeys(keys) {
    const output = [];
    const seen = new Set();

    for (const key of keys || []) {
        const cleaned = String(key || '').trim();
        if (!cleaned) {
            continue;
        }

        const normalized = cleaned.toLowerCase();
        if (seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        output.push(cleaned);
    }

    return output;
}

function getWorldEntryList(worldData) {
    return Object.values(worldData?.entries || {}).filter(Boolean);
}

function getWorldInfoName(settings) {
    if (settings.target_world_info && Array.isArray(world_names) && world_names.includes(settings.target_world_info)) {
        return settings.target_world_info;
    }

    if (Array.isArray(selected_world_info) && selected_world_info.length > 0) {
        return selected_world_info[0];
    }

    return '';
}

function findMatchingEntry(entry, worldData) {
    const nameNorm = normalizeName(entry.name);
    const keyNorms = new Set((entry.suggestedKeys || []).map(normalizeKey).filter(Boolean));

    for (const wiEntry of getWorldEntryList(worldData)) {
        const comment = String(wiEntry.comment || '');
        const commentNorm = comment.toLowerCase();
        const wiKeys = Array.isArray(wiEntry.key) ? wiEntry.key : [];
        const wiKeyNorms = wiKeys.map(normalizeKey).filter(Boolean);

        if (commentNorm.includes(`[dynamiclore:${nameNorm}]`)) {
            return wiEntry;
        }

        if (nameNorm && commentNorm.includes(nameNorm)) {
            return wiEntry;
        }

        for (const wiKey of wiKeyNorms) {
            if (keyNorms.has(wiKey)) {
                return wiEntry;
            }
        }
    }

    return null;
}

function mergeContent(oldContent, newContent) {
    const oldText = String(oldContent || '').trim();
    const newText = String(newContent || '').trim();

    if (!oldText) {
        return newText;
    }

    if (!newText) {
        return oldText;
    }

    if (oldText.toLowerCase().includes(newText.toLowerCase())) {
        return oldText;
    }

    return `${oldText}\n\n${newText}`;
}

function sanitizeEntry(raw) {
    const name = String(raw?.name || '').trim();
    const description = String(raw?.description || '').trim();

    if (!name || !description) {
        return null;
    }

    const keysSource = Array.isArray(raw?.suggestedKeys)
        ? raw.suggestedKeys
        : Array.isArray(raw?.keys)
            ? raw.keys
            : [name];

    const confidenceValue = Number(raw?.confidence);

    return {
        type: String(raw?.type || 'concept').trim() || 'concept',
        name,
        description,
        suggestedKeys: dedupeKeys(keysSource.length ? keysSource : [name]),
        confidence: Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0.6,
    };
}

function extractJsonCandidate(text) {
    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch && fencedMatch[1]) {
        return fencedMatch[1].trim();
    }

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start !== -1 && end > start) {
        return text.slice(start, end + 1);
    }

    return text;
}

function parseAnalysisResponse(rawResponse) {
    if (typeof rawResponse !== 'string' || !rawResponse.trim()) {
        return [];
    }

    const candidates = [rawResponse.trim(), extractJsonCandidate(rawResponse)];

    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }

        try {
            const parsed = JSON.parse(candidate);
            const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
            return entries.map(sanitizeEntry).filter(Boolean);
        } catch {
            // Try the next candidate.
        }
    }

    return [];
}

function buildPrompt(conversationText) {
    return `Analyze this roleplay conversation and return durable lorebook facts.\n\nConversation:\n${conversationText}\n\nReturn ONLY valid JSON with this shape:\n{\n  "entries": [\n    {\n      "type": "character|location|object|concept",\n      "name": "short entity name",\n      "description": "factual description",\n      "suggestedKeys": ["trigger key", "alias"],\n      "confidence": 0.0\n    }\n  ]\n}\n\nRules:\n- Include only facts that are stable and likely useful later.\n- Avoid temporary dialog details.\n- Keep descriptions concise (1-3 sentences).\n- If nothing useful exists, return {"entries":[]}.`;
}

function proposalCardId() {
    proposalCounter += 1;
    return `dynamiclore_proposal_${Date.now()}_${proposalCounter}`;
}

function refreshSettingsFromUI() {
    const settings = ensureSettings();
    settings.auto_analyze = $('#dynamiclore_auto_analyze').prop('checked');
    settings.auto_approve = $('#dynamiclore_auto_approve').prop('checked');
    settings.analysis_interval = Math.max(1, Number($('#dynamiclore_analysis_interval').val()) || 5);
    settings.target_world_info = String($('#dynamiclore_target_world').val() || '').trim();

    if (settings.message_count >= settings.analysis_interval) {
        settings.message_count = 0;
    }

    saveSettingsDebounced();
}

function syncSettingsToUI() {
    const settings = ensureSettings();
    $('#dynamiclore_auto_analyze').prop('checked', settings.auto_analyze);
    $('#dynamiclore_auto_approve').prop('checked', settings.auto_approve);
    $('#dynamiclore_analysis_interval').val(settings.analysis_interval);
    $('#dynamiclore_target_world').val(settings.target_world_info);
}

function upsertEntry(worldData, proposal) {
    let wiEntry = null;

    if (proposal.kind === 'update' && Number.isInteger(proposal.entryId)) {
        wiEntry = worldData.entries?.[proposal.entryId] || null;
    }

    if (!wiEntry) {
        wiEntry = findMatchingEntry(proposal, worldData);
    }

    if (!wiEntry) {
        wiEntry = createWorldInfoEntry(proposal.worldName, worldData);
    }

    if (!wiEntry) {
        return false;
    }

    const keys = dedupeKeys(proposal.suggestedKeys.length ? proposal.suggestedKeys : [proposal.name]);
    wiEntry.key = keys;
    wiEntry.keysecondary = Array.isArray(wiEntry.keysecondary) ? wiEntry.keysecondary : [];
    wiEntry.comment = `[DynamicLore:${normalizeName(proposal.name)}] ${proposal.name}`;
    wiEntry.content = proposal.mergedContent || proposal.description;
    wiEntry.disable = false;

    return true;
}

async function applyProposal(proposal) {
    const worldData = await loadWorldInfo(proposal.worldName);

    if (!worldData) {
        notify('error', `Could not load lorebook: ${proposal.worldName}`);
        return false;
    }

    if (!worldData.entries || typeof worldData.entries !== 'object') {
        worldData.entries = {};
    }

    const applied = upsertEntry(worldData, proposal);

    if (!applied) {
        notify('error', `Could not apply update for ${proposal.name}`);
        return false;
    }

    await saveWorldInfo(proposal.worldName, worldData, true);
    return true;
}

function removeProposalCard(cardId) {
    pendingProposals.delete(cardId);
    $(`#${cardId}`).remove();
}

function renderProposalCard(proposal) {
    const cardId = proposalCardId();
    pendingProposals.set(cardId, proposal);

    const isUpdate = proposal.kind === 'update';
    const confidencePercent = Math.round(proposal.confidence * 100);

    const html = isUpdate
        ? `
            <div id="${cardId}" class="dynamiclore_update_proposal">
                <div class="dynamiclore_proposal_header"><strong>${escapeHtml(proposal.name)}</strong> (${confidencePercent}% confidence)</div>
                <div class="dynamiclore_proposal_content">
                    <div class="dynamiclore_original"><strong>Original:</strong><pre>${escapeHtml(proposal.originalContent || '(empty)')}</pre></div>
                    <div class="dynamiclore_new"><strong>New Information:</strong><pre>${escapeHtml(proposal.description)}</pre></div>
                    <div class="dynamiclore_merged"><strong>Merged:</strong><pre>${escapeHtml(proposal.mergedContent)}</pre></div>
                </div>
                <div class="dynamiclore_proposal_actions">
                    <button class="menu_button dynamiclore_accept">Accept</button>
                    <button class="menu_button dynamiclore_reject">Reject</button>
                </div>
            </div>
        `
        : `
            <div id="${cardId}" class="dynamiclore_entry_proposal">
                <div class="dynamiclore_proposal_header"><strong>${escapeHtml(proposal.name)}</strong> (${escapeHtml(proposal.type)}, ${confidencePercent}% confidence)</div>
                <div class="dynamiclore_proposal_content">
                    <div class="dynamiclore_description"><pre>${escapeHtml(proposal.description)}</pre></div>
                    <div class="dynamiclore_keys"><strong>Suggested Keys:</strong> ${escapeHtml(proposal.suggestedKeys.join(', '))}</div>
                </div>
                <div class="dynamiclore_proposal_actions">
                    <button class="menu_button dynamiclore_accept">Accept</button>
                    <button class="menu_button dynamiclore_reject">Reject</button>
                </div>
            </div>
        `;

    if (isUpdate) {
        $('#dynamiclore_updates_list').append(html);
    } else {
        $('#dynamiclore_entries_list').append(html);
    }

    $(`#${cardId} .dynamiclore_accept`).on('click', async () => {
        const pending = pendingProposals.get(cardId);
        if (!pending) {
            return;
        }

        const ok = await applyProposal(pending);
        if (ok) {
            removeProposalCard(cardId);
            notify('success', `${pending.name} saved to ${pending.worldName}`);
        }
    });

    $(`#${cardId} .dynamiclore_reject`).on('click', () => {
        removeProposalCard(cardId);
    });
}

function appendPanelIfMissing() {
    if ($('#dynamiclore_panel').length) {
        return;
    }

    const menuContainer = $('#extensionsMenu');
    if (menuContainer.length && !$('#dynamicLore_button').length) {
        menuContainer.append(`
            <div id="dynamicLore_button" class="list-group-item">
                <span>DynamicLore</span>
            </div>
        `);
    }

    $('body').append(`
        <div id="dynamiclore_panel" class="drawer wide_drawer" style="display:none;">
            <div class="drawer-header">
                <span class="drawer_heading">DynamicLore - World Info Manager</span>
                <div class="menu_button fa-solid fa-xmark" id="dynamiclore_close"></div>
            </div>
            <div class="drawer-content">
                <div class="dynamiclore_controls">
                    <button id="dynamiclore_analyze" class="menu_button">Analyze Conversation</button>
                    <label><input id="dynamiclore_auto_analyze" type="checkbox" /> Auto-analyze</label>
                    <label><input id="dynamiclore_auto_approve" type="checkbox" /> Auto-approve high confidence</label>
                </div>
                <div class="dynamiclore_controls">
                    <label>Analyze every <input id="dynamiclore_analysis_interval" type="number" min="1" max="100" style="width:80px;" /> messages</label>
                    <label>Target lorebook <input id="dynamiclore_target_world" type="text" placeholder="(optional)" style="min-width:220px;" /></label>
                </div>
                <div class="dynamiclore_pending_updates">
                    <h3>Pending Updates</h3>
                    <div id="dynamiclore_updates_list"></div>
                </div>
                <div class="dynamiclore_pending_entries">
                    <h3>Suggested New Entries</h3>
                    <div id="dynamiclore_entries_list"></div>
                </div>
            </div>
        </div>
    `);

    $('#dynamicLore_button').on('click', () => $('#dynamiclore_panel').toggle());
    $('#dynamiclore_close').on('click', () => $('#dynamiclore_panel').hide());
    $('#dynamiclore_analyze').on('click', async () => {
        await analyzeCurrentChat({ manual: true });
    });

    $('#dynamiclore_auto_analyze').on('change', refreshSettingsFromUI);
    $('#dynamiclore_auto_approve').on('change', refreshSettingsFromUI);
    $('#dynamiclore_analysis_interval').on('change', refreshSettingsFromUI);
    $('#dynamiclore_target_world').on('change', refreshSettingsFromUI);

    syncSettingsToUI();
}

async function analyzeCurrentChat({ manual = false } = {}) {
    const settings = ensureSettings();

    if (isAnalyzing) {
        return;
    }

    const context = getContext();
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const usable = messages.filter(m => m && !m.is_system && typeof m.mes === 'string' && m.mes.trim().length > 0);

    if (usable.length === 0) {
        if (manual) {
            notify('warning', 'No chat messages available to analyze.');
        }
        return;
    }

    const worldName = getWorldInfoName(settings);
    if (!worldName) {
        if (manual) {
            notify('warning', 'No active lorebook found. Select a lorebook or set a target lorebook name.');
        }
        return;
    }

    const contextMessages = usable.slice(-MAX_CONTEXT_MESSAGES);
    const conversationText = contextMessages
        .map(m => `${m.is_user ? 'User' : 'Character'}: ${String(m.mes || '').trim()}`)
        .join('\n');

    const prompt = buildPrompt(conversationText);
    const systemPrompt = 'You are a careful lore extraction assistant. Output JSON only.';

    isAnalyzing = true;

    try {
        const raw = await generateRaw({
            prompt,
            systemPrompt,
            responseLength: 600,
            trimNames: false,
        });

        const extracted = parseAnalysisResponse(raw);

        if (!extracted.length) {
            if (manual) {
                notify('info', 'No useful lore updates detected in this conversation segment.');
            }
            return;
        }

        const worldData = await loadWorldInfo(worldName);
        if (!worldData) {
            notify('error', `Could not load lorebook: ${worldName}`);
            return;
        }

        if (!worldData.entries || typeof worldData.entries !== 'object') {
            worldData.entries = {};
        }

        const proposals = extracted.map(entry => {
            const match = findMatchingEntry(entry, worldData);

            if (match) {
                return {
                    ...entry,
                    kind: 'update',
                    worldName,
                    entryId: Number(match.uid),
                    originalContent: String(match.content || ''),
                    mergedContent: mergeContent(match.content, entry.description),
                };
            }

            return {
                ...entry,
                kind: 'new',
                worldName,
                entryId: null,
                originalContent: '',
                mergedContent: entry.description,
            };
        });

        const autoProposals = [];
        const pending = [];

        for (const proposal of proposals) {
            if (settings.auto_approve && proposal.confidence >= AUTO_APPROVE_THRESHOLD) {
                autoProposals.push(proposal);
            } else {
                pending.push(proposal);
            }
        }

        let savedCount = 0;
        for (const proposal of autoProposals) {
            const ok = upsertEntry(worldData, proposal);
            if (ok) {
                savedCount += 1;
            }
        }

        if (savedCount > 0) {
            await saveWorldInfo(worldName, worldData, true);
            notify('success', `Auto-saved ${savedCount} lore update${savedCount === 1 ? '' : 's'} to ${worldName}.`);
        }

        for (const proposal of pending) {
            renderProposalCard(proposal);
        }

        if (manual && pending.length === 0 && savedCount === 0) {
            notify('info', 'No actionable lore updates were produced.');
        }

        if (manual && pending.length > 0) {
            notify('info', `${pending.length} proposal${pending.length === 1 ? '' : 's'} ready for review.`);
        }
    } catch (error) {
        console.error('[DynamicLore] analysis failed', error);
        notify('error', 'Analysis failed. Check your model/API connection and console logs.');
    } finally {
        isAnalyzing = false;
    }
}

async function handleMessageRendered() {
    const settings = ensureSettings();

    if (!settings.auto_analyze) {
        return;
    }

    settings.message_count += 1;

    if (settings.message_count >= settings.analysis_interval) {
        settings.message_count = 0;
        await analyzeCurrentChat({ manual: false });
    }

    saveSettingsDebounced();
}

function registerListenersOnce() {
    if (listenersRegistered) {
        return;
    }

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleMessageRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, handleMessageRendered);
    listenersRegistered = true;
}

function registerSlashCommandOnce() {
    if (slashCommandRegistered) {
        return;
    }

    registerSlashCommand(
        'dynamiclore',
        async (_namedArgs, unnamedArgs) => {
            const args = Array.isArray(unnamedArgs)
                ? unnamedArgs
                : unnamedArgs
                    ? [unnamedArgs]
                    : [];

            const firstArg = String(args[0] || '').trim().toLowerCase();
            if (firstArg === 'analyze') {
                await analyzeCurrentChat({ manual: true });
                return 'ok';
            }

            $('#dynamiclore_panel').toggle();
            return 'ok';
        },
        ['dlore'],
        'Open DynamicLore panel, or run /dynamiclore analyze',
    );

    slashCommandRegistered = true;
}

jQuery(async () => {
    ensureSettings();
    appendPanelIfMissing();
    registerListenersOnce();
    registerSlashCommandOnce();
});

export { analyzeCurrentChat };
