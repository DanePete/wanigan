// Files for the next message: pasted, dropped or picked, shown as chips until
// the message goes. One piece for every composer that sends to an agent: a
// session's, Talk to Wanigan's. The core checks and keeps each file
// (attachments.save); the window only reads what the owner handed it.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ATTACH_MAX_BYTES, attachKey, formatBytes, type Attachment, type AttachmentKind, type AttachTo } from '@shared/attachments';
import { attempt, bridge, call, useQuery } from '../lib/api';
import { Icon } from './icons';
import { IconButton, useToast } from './ui';

type Incoming = File | { name: string; data: string };

export interface Attachments {
  /** Waiting for the next message, oldest first. */
  files: Attachment[];
  /** Files being read and saved right now. */
  adding: number;
  add: (files: readonly Incoming[]) => Promise<void>;
  /** The Attach dialog, through the app (a browser has none). */
  pick: () => Promise<void>;
  remove: (id: string) => void;
}

/** The files waiting in one composer; null `to` is a composer that takes none. */
export function useAttachments(to: AttachTo | null): Attachments {
  const toast = useToast();
  const key = to ? attachKey(to) : null;
  const list = useQuery('attachments.list', to ? { to } : null, ['attachments'], (_e, d) => (d as { key?: string } | null)?.key === key);
  const [adding, setAdding] = useState(0);
  const target = useRef(to);
  target.current = to;

  const add = useCallback(async (incoming: readonly Incoming[]): Promise<void> => {
    const where = target.current;
    if (!where || !incoming.length) return;
    setAdding((n) => n + incoming.length);
    // One at a time, in order: the core numbers them as they arrive.
    for (const file of incoming) {
      try {
        if (file instanceof File && file.size > ATTACH_MAX_BYTES) {
          toast(`${file.name || 'That file'} is ${formatBytes(file.size)}. A file can be at most ${formatBytes(ATTACH_MAX_BYTES)}.`, 'error');
          continue;
        }
        const data = file instanceof File ? await base64(file) : file.data;
        await attempt(() => call('attachments.save', { to: where, name: file.name || 'pasted', data }), (m) => toast(m, 'error'));
      } catch (error) {
        toast(`${file.name || 'That file'} could not be read: ${(error as Error).message}`, 'error');
      } finally {
        setAdding((n) => n - 1);
      }
    }
  }, [toast]);

  const pick = useCallback(async (): Promise<void> => {
    const picked = await bridge().pickFiles();
    if (!picked) return;
    for (const why of picked.refused) toast(why, 'error');
    await add(picked.files);
  }, [add, toast]);

  const remove = useCallback((id: string): void => {
    void attempt(() => call('attachments.remove', { id }), (m) => toast(m, 'error'));
  }, [toast]);

  return { files: to ? list.data ?? [] : [], adding, add, pick, remove };
}

/**
 * Files pasted or dropped anywhere in `zone` (a terminal, a composer, a whole
 * dialog) go to `onFiles`. Text pastes and drags of anything else pass through
 * untouched. While files are dragged over it, the zone carries `drop-over`.
 */
export function useFileDrop(zone: RefObject<HTMLElement | null>, onFiles: (files: File[]) => void): void {
  const handler = useRef(onFiles);
  handler.current = onFiles;
  useEffect(() => {
    const el = zone.current;
    if (!el) return;
    let depth = 0;
    const carriesFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const mark = (on: boolean): void => { el.classList.toggle('drop-over', on); };
    const enter = (e: DragEvent): void => { if (!carriesFiles(e)) return; e.preventDefault(); depth++; mark(true); };
    const over = (e: DragEvent): void => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent): void => { if (!carriesFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) mark(false); };
    const drop = (e: DragEvent): void => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      mark(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) handler.current(files);
    };
    // Capture, so a paste with files never reaches the terminal or the text box.
    const paste = (e: ClipboardEvent): void => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      handler.current(files);
    };
    el.addEventListener('dragenter', enter);
    el.addEventListener('dragover', over);
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', drop);
    el.addEventListener('paste', paste, true);
    return () => {
      el.removeEventListener('dragenter', enter);
      el.removeEventListener('dragover', over);
      el.removeEventListener('dragleave', leave);
      el.removeEventListener('drop', drop);
      el.removeEventListener('paste', paste, true);
      mark(false);
    };
  }, [zone]);
}

/** The paperclip: opens the Attach dialog. */
export function AttachButton({ onPick, disabled }: { onPick: () => Promise<void>; disabled?: boolean }) {
  return <IconButton icon="attach" label="Attach images or files" onClick={() => onPick()} disabled={disabled} />;
}

/** Each file as a chip: a thumbnail for an image, otherwise its name and size, with a remove button while it waits. */
export function AttachmentChips({ files, adding = 0, onRemove, label = 'Files for the next message' }: {
  files: readonly { id: string; name: string; kind: AttachmentKind; size: number }[];
  adding?: number;
  onRemove?: (id: string) => void;
  label?: string;
}) {
  if (!files.length && !adding) return null;
  return (
    <ul className="attach-chips" aria-label={label}>
      {files.map((f) => <Chip key={f.id} file={f} onRemove={onRemove} />)}
      {adding ? <li className="attach-chip attach-adding" role="status">Attaching {adding === 1 ? 'a file' : `${adding} files`}…</li> : null}
    </ul>
  );
}

function Chip({ file, onRemove }: { file: { id: string; name: string; kind: AttachmentKind; size: number }; onRemove?: (id: string) => void }) {
  const preview = useQuery('attachments.preview', file.kind === 'image' ? { id: file.id } : null, []);
  const thumb = preview.data?.dataUrl ?? null;
  return (
    <li className="attach-chip" title={`${file.name} · ${formatBytes(file.size)}`}>
      {thumb ? <img className="attach-thumb" src={thumb} alt="" /> : (
        <span className="attach-icon"><Icon name={file.kind === 'image' ? 'image' : 'file'} size={14} /></span>
      )}
      <span className="attach-name">{file.name}</span>
      <span className="attach-size">{file.kind === 'pdf' ? 'PDF · ' : ''}{formatBytes(file.size)}</span>
      {onRemove ? (
        <button type="button" className="attach-x" aria-label={`Remove ${file.name}`} title="Remove" onClick={() => onRemove(file.id)}>
          <Icon name="close" size={12} />
        </button>
      ) : null}
    </li>
  );
}

function base64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const url = String(reader.result); resolve(url.slice(url.indexOf(',') + 1)); };
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}
