// Compact model picker: providers live on a Cloud/Local rail. Ready engines
// show a short suggested list with search and an explicit all-models view;
// engines that need setup show one focused action instead of a disabled wall.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, Zap } from "lucide-react";
import { useStore, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import { filterCustomModels, partitionCustomModels, suggestedModels } from "@/lib/custom-models";
import { isCustomOnly, isFleetInstance, splitEngineRail } from "@/lib/engine-rail";
import { ProviderMark } from "./ProviderIcons";
import { EngineSetup, needsCli, needsSignIn } from "./EngineSetup";
import { EngineGroupLabel } from "./EngineGroupLabel";
import { cn } from "@/lib/cn";
import { COMPACT_SQUARE } from "@/lib/compact-chip";
import { isVBotReconstructedActive, vbotProviderInstances } from "@/lib/vbot-engine";
import {
  buildModelFamilies,
  createModelDraft,
  browseProvider,
  selectModelInDraft,
  toggleFastInDraft,
  toggleOneMInDraft,
  setEffortInDraft,
  selectSourceInDraft,
  isDraftDirty,
  type ModelDraftState,
} from "@/lib/model-family";

type ModelOption = InstanceInfo["models"]["options"][number];
const COMPACT_MODEL_COUNT = 5;

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

function engineStatus(instance: InstanceInfo): string {
  if (needsCli(instance)) return "Not installed";
  if (needsSignIn(instance)) return "Sign-in required";
  return instance.snapshot.version ?? "Ready";
}

function ModelRow({
  option,
  current,
  defaultId,
  onPick,
}: {
  option: ModelOption;
  current: boolean;
  defaultId: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-control/60",
        current && "bg-control",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{option.label}</span>
        {option.id === defaultId && (
          <span className="shrink-0 rounded bg-inset px-1.5 py-px text-[10px] text-ink-secondary">Default</span>
        )}
        {option.loaded && (
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px text-[10px] text-accent">Loaded</span>
        )}
      </span>
      {current && <Check size={14} className="shrink-0 text-accent" />}
    </button>
  );
}

function ModelSearch({
  value,
  onChange,
  onEscape,
  local,
}: {
  value: string;
  onChange: (value: string) => void;
  onEscape: () => void;
  local: boolean;
}) {
  return (
    <div className="shrink-0 px-2 pb-2">
      <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 focus-within:border-accent/60">
        <Search size={13} className="shrink-0 text-ink-secondary" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            onEscape();
          }}
          placeholder="Search models"
          aria-label={local ? "Search local models" : "Search models"}
          className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
      </div>
    </div>
  );
}

export function ModelPicker({
  bot,
  className,
  contained = false,
  label,
  initialOpen = false,
}: {
  bot: Bot;
  className?: string;
  /** Expand the menu in-flow under the trigger so it cannot overflow a
   * narrow parent (the Agent profile sidebar). */
  contained?: boolean;
  label?: ReactNode;
  initialOpen?: boolean;
}) {
  const { state, dispatch, refreshInstances, refreshEngineSync } = useStore();
  const [open, setOpen] = useState(initialOpen);
  const [railId, setRailId] = useState<string | null>(null);
  const [pane, setPane] = useState<"main" | "custom">("main");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selection = bot.modelSelection;
  const reconstructedActive = isVBotReconstructedActive(state.engineSync);
  const pickerInstances = reconstructedActive ? vbotProviderInstances(state.engineSync!) : state.instances;
  const [draft, setDraft] = useState<ModelDraftState>(() => createModelDraft(selection, pickerInstances));
  const active = pickerInstances.find((instance) => instance.instanceId === selection.instanceId);
  const railInstance =
    pickerInstances.find((instance) => instance.instanceId === (railId ?? draft.draftInstanceId ?? selection.instanceId)) ?? pickerInstances[0];
  const engineSelectionBlocked = state.engineSync?.primaryEngine === "grokReconstructed" && !reconstructedActive;

  useEffect(() => {
    if (!open) {
      setDraft(createModelDraft(selection, pickerInstances));
      setRailId(selection.instanceId);
    }
  }, [open, selection, pickerInstances]);

  useEffect(() => {
    if (!open) return;
    void refreshInstances();
    if (state.engineSync?.primaryEngine === "grokReconstructed") void refreshEngineSync();
  }, [open, refreshInstances, refreshEngineSync, state.engineSync?.primaryEngine]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const clickedNode = event.target instanceof Node ? event.target : null;
      if (!rootRef.current?.contains(clickedNode)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (query) setQuery("");
      else if (pane === "custom" && railInstance?.models.options.some((option) => !option.custom)) setPane("main");
      else setOpen(false);
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, pane, query, railInstance]);

  const resetList = () => {
    setQuery("");
    setShowAll(false);
  };

  const openFor = (instance: InstanceInfo | undefined) => {
    const official = instance?.models.options.filter((option) => !option.custom) ?? [];
    const selectedIsCustom = instance?.models.options.some(
      (option) => option.id === selection.model && option.custom,
    );
    setPane(
      isFleetInstance(instance)
        ? "main"
        : selectedIsCustom || isCustomOnly(instance) || official.length === 0
          ? "custom"
          : "main",
    );
    resetList();
  };

  const selectRail = (instance: InstanceInfo) => {
    setRailId(instance.instanceId);
    setDraft((prev) => browseProvider(prev, instance.instanceId));
    const official = instance.models.options.filter((option) => !option.custom);
    setPane(isFleetInstance(instance) || !(isCustomOnly(instance) || official.length === 0) ? "main" : "custom");
    resetList();
  };

  const pick = (instance: InstanceInfo, modelId: string) => {
    const families = buildModelFamilies(pickerInstances);
    const family =
      families.find((f) =>
        f.sources.some((s) => s.instanceId === instance.instanceId && s.variants.some((v) => v.modelId === modelId))
      ) ?? families.find((f) => f.key === modelId);

    if (family) {
      setDraft((prev) => selectModelInDraft(prev, family, instance.instanceId, modelId));
    } else {
      setDraft((prev) => ({
        ...prev,
        draftInstanceId: instance.instanceId,
        draftModel: modelId,
      }));
    }
  };

  const applyChanges = () => {
    const nextSelection: ModelSelection = {
      instanceId: draft.draftInstanceId,
      model: draft.draftModel,
    };
    if (draft.draftEffort) nextSelection.effort = draft.draftEffort as any;
    dispatch({
      type: "setModel",
      botId: bot.id,
      selection: nextSelection,
    });
    setOpen(false);
  };

  const selectionLabel = active
    ? isFleetInstance(active)
      ? `${active.displayName} · ${modelLabel(active, selection.model)}`
      : modelLabel(active, selection.model)
    : selection.model;

  const official = railInstance?.models.options.filter((option) => !option.custom) ?? [];
  const custom = railInstance?.models.options.filter((option) => option.custom) ?? [];
  const currentModel = selection.instanceId === railInstance?.instanceId ? selection.model : undefined;
  const filteredOfficial = filterCustomModels(official, query);
  const compactOfficial = railInstance
    ? suggestedModels(official, railInstance.models.default, currentModel, COMPACT_MODEL_COUNT)
    : [];
  const shownOfficial = query ? filteredOfficial : showAll ? official : compactOfficial;
  const filteredCustom = filterCustomModels(custom, query);
  const { pinned, rest } = partitionCustomModels(filteredCustom);
  const blocked = engineSelectionBlocked || (railInstance
    ? pane === "custom"
      ? needsCli(railInstance)
      : needsCli(railInstance) || needsSignIn(railInstance)
    : false);
  const canOpenCustom = Boolean(railInstance && !needsCli(railInstance));
  const canReturnToOfficial = official.length > 0 && !isCustomOnly(railInstance);

  const families = buildModelFamilies(pickerInstances);
  const draftFamily =
    families.find((f) =>
      f.sources.some(
        (s) => s.instanceId === draft.draftInstanceId && s.variants.some((v) => v.modelId === draft.draftModel)
      )
    ) ?? families.find((f) => f.key === draft.draftModel);
  const draftSource = draftFamily?.sources.find((s) => s.instanceId === draft.draftInstanceId);
  const supportsFast = Boolean(draftSource?.variants.some((v) => v.axes.fast));
  const supportsOneM = Boolean(draftSource?.variants.some((v) => v.axes.oneM));
  const capabilityEfforts = draftSource?.capabilityEffortLevels ?? [];
  const encodedEfforts = draftSource?.effortEncodedInModelId
    ? (Array.from(new Set(draftSource.variants.map((v) => v.axes.effort).filter(Boolean))) as string[])
    : [];
  const effortLevels = capabilityEfforts.length > 0 ? capabilityEfforts : encodedEfforts;
  const availableSources = draftFamily?.sources.filter((s) => s.available) ?? [];

  const renderRow = (option: ModelOption) => (
    <ModelRow
      key={option.id}
      option={option}
      current={draft.draftInstanceId === railInstance?.instanceId && draft.draftModel === option.id}
      defaultId={railInstance?.models.default ?? ""}
      onPick={() => railInstance && pick(railInstance, option.id)}
    />
  );

  const trigger = (
    <button
      type="button"
      onClick={() => {
        setRailId(selection.instanceId);
        setOpen((wasOpen) => {
          const next = !wasOpen;
          if (next) openFor(pickerInstances.find((instance) => instance.instanceId === selection.instanceId));
          return next;
        });
      }}
      aria-expanded={open}
      aria-haspopup="dialog"
      className={cn(
        "flex items-center gap-1.5 rounded-full border border-hairline/40 bg-control/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised-hover",
        // in a narrow chat header fold to a rounded square with just the
        // provider mark; the model name rides the tooltip (a bot with no
        // resolved engine keeps its label — the mark is what would hide it)
        !contained && active && COMPACT_SQUARE,
      )}
      title={active ? `${active.displayName} · ${modelLabel(active, selection.model)}` : selectionLabel}
    >
      {active && <ProviderMark driverKind={active.driverKind} size={14} />}
      <span className={cn("max-w-[160px] truncate", !contained && active && "@max-4xl/chathead:hidden")}>
        {selectionLabel}
      </span>
      <ChevronDown
        size={14}
        className={cn(
          "text-ink-secondary transition-transform",
          open && "rotate-180",
          !contained && active && "@max-4xl/chathead:hidden",
        )}
      />
    </button>
  );

  return (
    <div ref={rootRef} className={cn(contained ? "w-full" : "relative", className)}>
      {contained ? (
        <div className="flex items-center justify-between gap-4">
          {label}
          {trigger}
        </div>
      ) : (
        trigger
      )}

      {open && (
        <div
          data-model-picker-content
          role="dialog"
          aria-label="Choose model"
          className={cn(
            "flex overflow-hidden rounded-2xl border border-hairline/50 bg-card",
            contained
              ? "relative mt-3 w-full max-h-[min(420px,50dvh)]"
              : "absolute right-0 top-full z-30 mt-2 w-[380px] max-h-[min(480px,calc(100dvh-7rem))] shadow-2xl shadow-black/50",
          )}
        >
          <div className="flex w-14 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/40 bg-panel p-2">
            {(() => {
              const { subscription, custom: local, fleet } = splitEngineRail(pickerInstances);
              const railButton = (instance: InstanceInfo) => {
                const selected = instance.instanceId === railInstance?.instanceId;
                const attention = needsCli(instance) || needsSignIn(instance);
                return (
                  <button
                    type="button"
                    key={instance.instanceId}
                    onClick={() => selectRail(instance)}
                    aria-label={instance.displayName}
                    aria-pressed={selected}
                    title={`${instance.displayName} · ${engineStatus(instance)}`}
                    className={cn(
                      "relative flex size-9 items-center justify-center rounded-lg",
                      selected ? "bg-control ring-1 ring-hairline/50" : "hover:bg-control/60",
                    )}
                  >
                    <ProviderMark driverKind={instance.driverKind} size={18} />
                    {attention && (
                      <span className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full bg-warning ring-2 ring-panel" />
                    )}
                  </button>
                );
              };
              return (
                <>
                  {subscription.length > 0 && (
                    <EngineGroupLabel className="px-0 pb-0.5 pt-0.5 text-center text-[9px]">Cloud</EngineGroupLabel>
                  )}
                  {subscription.map(railButton)}
                  {local.length > 0 && (
                    <EngineGroupLabel className="px-0 pb-0.5 pt-2 text-center text-[9px]">Local</EngineGroupLabel>
                  )}
                  {local.map(railButton)}
                  {fleet.length > 0 && (
                    <EngineGroupLabel className="px-0 pb-0.5 pt-2 text-center text-[9px]">Fleet</EngineGroupLabel>
                  )}
                  {fleet.map(railButton)}
                </>
              );
            })()}
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {railInstance ? (
              <>
                <div className="shrink-0 px-4 pb-2 pt-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-[14px] font-semibold text-ink">{railInstance.displayName}</div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                        blocked ? "bg-warning/10 text-warning" : "bg-success/10 text-success",
                      )}
                    >
                      {pane === "custom" && !blocked ? "Local models" : engineStatus(railInstance)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                    {isFleetInstance(railInstance)
                      ? "Models this machine is advertising through its V Bot bridge."
                      : pane === "custom"
                        ? "Run this agent with a model already on your machine."
                        : "Choose a model for this bot."}
                  </div>
                </div>

                {pane === "custom" && canReturnToOfficial && (
                  <button
                    type="button"
                    onClick={() => {
                      setPane("main");
                      resetList();
                    }}
                    className="mx-2 mb-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] text-ink-secondary hover:bg-control/60"
                  >
                    <ChevronLeft size={13} /> Back to {railInstance.displayName} models
                  </button>
                )}

                {blocked ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
                    {engineSelectionBlocked ? (
                      <div className="rounded-xl border border-warning/25 bg-warning/10 p-3 text-[12.5px] leading-relaxed text-warning">
                        Grok Reconstructed is selected but unavailable. Start its local desktop gateway, then reopen this picker.
                        {state.engineSync?.fallbackReason && (
                          <div className="mt-1 text-[11.5px] text-warning/80">{state.engineSync.fallbackReason}</div>
                        )}
                      </div>
                    ) : railInstance ? (
                      <>
                        <EngineSetup instance={railInstance} intent={pane === "custom" ? "inject" : "cloud"} />
                        <p className="mt-2 text-center text-[11.5px] text-ink-secondary/70">
                          {pane === "main" && official.length > 0
                            ? `${official.length} ${official.length === 1 ? "model" : "models"} will appear after setup.`
                            : "Local models will appear as soon as the agent is installed."}
                        </p>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <>
                    {((pane === "main" && official.length > COMPACT_MODEL_COUNT) ||
                      (pane === "custom" && custom.length > COMPACT_MODEL_COUNT)) && (
                      <ModelSearch
                        value={query}
                        local={pane === "custom"}
                        onChange={(value) => {
                          setQuery(value);
                          if (value) setShowAll(true);
                        }}
                        onEscape={() => {
                          if (query) setQuery("");
                          else if (pane === "custom" && canReturnToOfficial) setPane("main");
                        }}
                      />
                    )}

                    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                      {pane === "main" ? (
                        <>
                          <EngineGroupLabel className="px-2 pb-1 pt-0.5">
                            {query ? `${filteredOfficial.length} results` : showAll ? `All models · ${official.length}` : "Suggested"}
                          </EngineGroupLabel>
                          {shownOfficial.map(renderRow)}
                          {shownOfficial.length === 0 && (
                            <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
                              Nothing matches “{query.trim()}”
                            </div>
                          )}
                          {!query && !showAll && official.length > compactOfficial.length && (
                            <button
                              type="button"
                              onClick={() => setShowAll(true)}
                              className="mt-1 flex w-full items-center justify-between rounded-lg border-t border-hairline/40 px-2.5 py-2 text-[12.5px] font-medium text-ink-secondary hover:bg-control/60 hover:text-ink"
                            >
                              Show all {official.length} models <ChevronDown size={13} />
                            </button>
                          )}
                          {!query && showAll && official.length > COMPACT_MODEL_COUNT && (
                            <button
                              type="button"
                              onClick={() => setShowAll(false)}
                              className="mt-1 w-full rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-control/60 hover:text-ink"
                            >
                              Show suggested only
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          {pinned.length > 0 && (
                            <EngineGroupLabel className="px-2 pb-1 pt-0.5">Loaded now</EngineGroupLabel>
                          )}
                          {pinned.map(renderRow)}
                          {pinned.length > 0 && rest.length > 0 && (
                            <div className="mx-2 my-2 border-t border-hairline/40" role="separator" />
                          )}
                          {rest.map(renderRow)}
                          {custom.length === 0 && (
                            <div className="mx-1 rounded-xl border border-dashed border-hairline/50 px-3 py-5 text-center">
                              <div className="text-[12.5px] font-medium text-ink">No local models found</div>
                              <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
                                Start oMLX, Ollama, Unsloth, LM Studio, or EXO, then reopen this picker.
                              </div>
                            </div>
                          )}
                          {custom.length > 0 && filteredCustom.length === 0 && (
                            <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
                              Nothing matches “{query.trim()}”
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}

                {pane === "main" && !isFleetInstance(railInstance) && (
                  <button
                    type="button"
                    aria-label={
                      custom.length > 0 ? `Use a local model (${custom.length} available)` : "Use a local model"
                    }
                    disabled={!canOpenCustom}
                    onClick={() => {
                      setPane("custom");
                      resetList();
                    }}
                    className="flex w-full shrink-0 items-center justify-between gap-2 border-t border-hairline/40 px-4 py-3 text-left text-[12.5px] font-medium text-ink hover:bg-control/60 disabled:cursor-not-allowed disabled:text-ink-secondary/40 disabled:hover:bg-transparent"
                  >
                    <span>Use a local model</span>
                    <span className="flex items-center gap-2">
                      {custom.length > 0 && (
                        <span className="rounded-full bg-inset px-2 py-0.5 text-[10.5px] text-ink-secondary">
                          {custom.length} available
                        </span>
                      )}
                      <ChevronRight size={14} className="text-ink-secondary" />
                    </span>
                  </button>
                )}

                {(supportsFast || supportsOneM || effortLevels.length > 0 || availableSources.length > 1) && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-hairline/30 bg-inset/50 px-3 py-2 text-[12px]">
                    {supportsFast && (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={draft.draftFast}
                        aria-label="Fast generation"
                        onClick={() => draftFamily && setDraft((prev) => toggleFastInDraft(prev, draftFamily))}
                        className={cn(
                          "flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium transition-colors",
                          draft.draftFast
                            ? "bg-accent text-white"
                            : "border border-hairline/40 bg-control text-ink-secondary hover:text-ink",
                        )}
                        title="Uses the advertised Fast variant of this exact model on the same source."
                      >
                        <Zap size={12} />
                        Fast generation
                      </button>
                    )}

                    {supportsOneM && (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={draft.draftOneM}
                        aria-label="1M context"
                        onClick={() => draftFamily && setDraft((prev) => toggleOneMInDraft(prev, draftFamily))}
                        className={cn(
                          "flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium transition-colors",
                          draft.draftOneM
                            ? "bg-accent text-white"
                            : "border border-hairline/40 bg-control text-ink-secondary hover:text-ink",
                        )}
                        title="Use 1M context window"
                      >
                        1M context
                      </button>
                    )}

                    {effortLevels.length > 0 && (
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] text-ink-secondary">Reasoning:</span>
                        <div className="flex overflow-hidden rounded border border-hairline/40">
                          {([undefined, ...effortLevels] as const).map((level) => (
                            <button
                              key={level ?? "default"}
                              type="button"
                              onClick={() => draftFamily && setDraft((prev) => setEffortInDraft(prev, draftFamily, level))}
                              className={cn(
                                "px-1.5 py-0.5 text-[10.5px] capitalize",
                                draft.draftEffort === level
                                  ? "bg-control font-medium text-ink"
                                  : "text-ink-secondary hover:text-ink",
                              )}
                            >
                              {level === "xhigh" ? "X-High" : (level ?? "Default")}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {availableSources.length > 1 && (
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] text-ink-secondary">Source:</span>
                        <select
                          value={draft.draftInstanceId}
                          onChange={(e) =>
                            draftFamily && setDraft((prev) => selectSourceInDraft(prev, draftFamily, e.target.value))
                          }
                          className="rounded border border-hairline/40 bg-control px-1.5 py-0.5 text-[11px] text-ink"
                        >
                          {availableSources.map((s) => (
                            <option key={s.instanceId} value={s.instanceId}>
                              {s.displayName}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between border-t border-hairline/40 bg-panel/70 px-3 py-2">
                  <div className="min-w-0 flex-1 truncate text-[11.5px] text-ink-secondary">
                    {isDraftDirty(draft) ? (
                      <span className="font-medium text-accent">Unsaved changes</span>
                    ) : (
                      <span>Current selection</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(createModelDraft(selection, pickerInstances));
                        setOpen(false);
                      }}
                      className="rounded-lg px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!isDraftDirty(draft)}
                      onClick={applyChanges}
                      className="rounded-lg bg-accent px-3 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="px-4 py-5 text-[13px] text-ink-secondary">No model providers are available.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
