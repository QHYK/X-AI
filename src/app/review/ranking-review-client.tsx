"use client";

/**
 * Event 与 Long-form Review 共用的本地排序交互。
 * drag / Move to N 只更新浏览器 state，Save Changes 才统一提交完整顺序和 touched IDs。
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMemo, useState, type ReactNode } from "react";
import type {
  EventReviewData,
  EventReviewItem,
  LongFormReviewData,
  LongFormReviewItem,
} from "@/lib/review.js";
import styles from "./review.module.css";

type SaveState = "idle" | "saving" | "saved" | "error";

const X_AI_API_BASE_URL = process.env.X_AI_API_BASE_URL ?? "/ai";

export function EventRankingReview({ data }: { data: EventReviewData }) {
  return (
    <RankingEditor
      dailyDate={data.dailyDate}
      cutoff={data.cutoff}
      endpoint={`${X_AI_API_BASE_URL}/api/review/events/ranking`}
      reviewRunId={data.reviewRunId}
      initialItems={data.items}
      renderContent={(item, rank) => <EventContent item={item} rank={rank} cutoff={data.cutoff} />}
    />
  );
}

export function LongFormRankingReview({ data }: { data: LongFormReviewData }) {
  return (
    <RankingEditor
      dailyDate={data.dailyDate}
      cutoff={data.cutoff}
      endpoint={`${X_AI_API_BASE_URL}/api/review/long-form/ranking`}
      initialItems={data.items}
      renderContent={(item, rank) => <LongFormContent item={item} rank={rank} />}
    />
  );
}

function RankingEditor<T extends { id: string; aiRank: number; displayRank: number }>(props: {
  dailyDate: string;
  cutoff: number;
  endpoint: string;
  reviewRunId?: string | null;
  initialItems: T[];
  renderContent: (item: T, rank: number) => ReactNode;
}) {
  const [items, setItems] = useState(() => [...props.initialItems].sort(byDisplayRank));
  const [touchedIds, setTouchedIds] = useState<Set<string>>(() => new Set());
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [initialRankById, setInitialRankById] = useState(
    () => new Map(props.initialItems.map((item) => [item.id, item.displayRank])),
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const meaningfulTouchedIds = useMemo(
    () =>
      [...touchedIds].filter((id) => {
        const finalRank = items.findIndex((item) => item.id === id) + 1;
        return finalRank > 0 && initialRankById.get(id) !== finalRank;
      }),
    [initialRankById, items, touchedIds],
  );

  function moveItem(id: string, targetRank: number): void {
    const from = items.findIndex((item) => item.id === id);
    const to = Math.max(0, Math.min(items.length - 1, targetRank - 1));
    if (from < 0 || from === to) {
      return;
    }
    setItems((current) => arrayMove(current, from, to));
    setTouchedIds((current) => new Set(current).add(id));
    setSaveState("idle");
    setMessage(null);
  }

  function handleDragEnd(event: DragEndEvent): void {
    if (!event.over || event.active.id === event.over.id) {
      return;
    }
    const from = items.findIndex((item) => item.id === event.active.id);
    const to = items.findIndex((item) => item.id === event.over?.id);
    if (from < 0 || to < 0) {
      return;
    }
    setItems((current) => arrayMove(current, from, to));
    setTouchedIds((current) => new Set(current).add(String(event.active.id)));
    setSaveState("idle");
    setMessage(null);
  }

  async function saveChanges(): Promise<void> {
    if (meaningfulTouchedIds.length === 0) {
      setMessage("No final ranking changes to save.");
      return;
    }
    setSaveState("saving");
    setMessage(null);
    try {
      const response = await fetch(props.endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: props.dailyDate,
          reviewRunId: props.reviewRunId,
          orderedIds: items.map((item) => item.id),
          touchedIds: [...touchedIds],
        }),
      });
      const result: { error?: string; feedbackCount?: number } = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? "Failed to save ranking changes.");
      }

      const rankedItems = items.map((item, index) => ({ ...item, displayRank: index + 1 }));
      setItems(rankedItems);
      setInitialRankById(new Map(rankedItems.map((item) => [item.id, item.displayRank])));
      setTouchedIds(new Set());
      setSaveState("saved");
      setMessage(`Saved. ${result.feedbackCount ?? 0} feedback record(s) created.`);
    } catch (error) {
      setSaveState("error");
      setMessage(error instanceof Error ? error.message : "Failed to save ranking changes.");
    }
  }

  if (items.length === 0) {
    return <div className={styles.empty}>No ranked items are available for this date.</div>;
  }

  return (
    <>
      <div className={styles.saveBar}>
        <p>
          Changes stay local until saved. Only directly moved items create feedback.
        </p>
        <div>
          {message ? (
            <span className={saveState === "error" ? styles.error : styles.message} role="status">
              {message}
            </span>
          ) : null}
          <button
            type="button"
            onClick={saveChanges}
            disabled={saveState === "saving" || meaningfulTouchedIds.length === 0}
          >
            {saveState === "saving" ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className={styles.rankedList}>
            {items.map((item, index) => (
              <SortableItem
                key={item.id}
                id={item.id}
                rank={index + 1}
                count={items.length}
                touched={touchedIds.has(item.id)}
                onMove={(rank) => moveItem(item.id, rank)}
              >
                {props.renderContent(item, index + 1)}
              </SortableItem>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </>
  );
}

function SortableItem(props: {
  id: string;
  rank: number;
  count: number;
  touched: boolean;
  onMove: (rank: number) => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });
  return (
    <article
      ref={setNodeRef}
      className={`${styles.reviewItem} ${isDragging ? styles.dragging : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className={styles.itemControls}>
        <button
          type="button"
          className={styles.dragHandle}
          aria-label={`Drag rank ${props.rank}`}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <strong>#{props.rank}</strong>
        {props.touched ? <span className={styles.touched}>Moved</span> : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = Number(new FormData(event.currentTarget).get("rank"));
            if (Number.isInteger(value)) {
              props.onMove(value);
            }
          }}
        >
          <label>
            Move to
            <input name="rank" type="number" min={1} max={props.count} required />
          </label>
          <button type="submit">Move</button>
        </form>
      </div>
      {props.children}
    </article>
  );
}

function EventContent({ item, rank, cutoff }: { item: EventReviewItem; rank: number; cutoff: number }) {
  const finalEvent = rank <= cutoff ? item.finalEvent : null;
  return (
    <div className={styles.itemContent}>
      <div className={styles.itemMeta}>
        <span>AI rank #{item.aiRank}</span>
        <span>{rank <= cutoff ? `Published selection · Top ${cutoff}` : "Review candidate"}</span>
        <span>{item.eventTempId}</span>
      </div>
      {finalEvent ? (
        <>
          <h2>{finalEvent.titleZh}</h2>
          <p className={styles.summary}>{finalEvent.summaryZh}</p>
          <TagLine label="Tags" values={[...finalEvent.tagsZh]} />
          <TagLine label="Entities" values={[...finalEvent.entitiesZh]} />
        </>
      ) : (
        <>
          <h2>{item.eventHint}</h2>
          <p className={styles.fallback}>Stage 4 content unavailable; showing Event Group candidates.</p>
        </>
      )}
      {/* <div className={styles.candidates}>
        {item.candidates.map((candidate) => (
          <section key={candidate.id}>
            <div className={styles.sourceLine}>
              <strong>{candidate.source}</strong>
              {candidate.url ? <a href={candidate.url} target="_blank" rel="noreferrer">Original ↗</a> : null}
            </div>
            <h3>{candidate.title}</h3>
            {!finalEvent && candidate.titleZh ? <p className={styles.titleZh}>{candidate.titleZh}</p> : null}
            {!finalEvent && candidate.summaryZh ? <p>{candidate.summaryZh}</p> : null}
            {!finalEvent ? <TagLine label="Tags" values={candidate.tags} /> : null}
            {!finalEvent ? <TagLine label="Entities" values={[...candidate.entitiesZh, ...candidate.entities]} /> : null}
          </section>
        ))}
      </div> */}
    </div>
  );
}

function LongFormContent({ item }: { item: LongFormReviewItem; rank: number }) {
  return (
    <div className={styles.itemContent}>
      <div className={styles.itemMeta}>
        <span>AI rank #{item.aiRank}</span>
        <span>{item.source}</span>
      </div>
      <h2>{item.titleZh ?? "Untitled"}</h2>
      {item.summaryZh ? <p className={styles.summary}>{item.summaryZh}</p> : null}
      {item.url ? <a className={styles.originalLink} href={item.url} target="_blank" rel="noreferrer">Read original ↗</a> : null}
    </div>
  );
}

function TagLine({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) {
    return null;
  }
  return (
    <div className={styles.tagLine}>
      <span>{label}</span>
      {[...new Set(values)].map((value) => <em key={value}>{value}</em>)}
    </div>
  );
}

function byDisplayRank<T extends { displayRank: number }>(left: T, right: T): number {
  return left.displayRank - right.displayRank;
}
