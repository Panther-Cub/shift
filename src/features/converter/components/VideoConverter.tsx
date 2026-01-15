import { useMemo, useState, useEffect, useRef } from 'react';
import { convertWebPToMp4 } from '@/features/converter/api/convert';
import { Button } from '@/components/ui/button';
import { Upload, CheckCircle2, AlertCircle, Play, Trash2, FileVideo, Folder } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';

type JobStatus = 'idle' | 'converting' | 'success' | 'error';

type QualityPreset = 'high' | 'balanced' | 'small';

type JobOptions = {
  quality: QualityPreset;
  fps: number | null;
};

type JobItem = {
  id: string;
  path: string;
  name: string;
  sequence: number;
  status: JobStatus;
  progress: number;
  error?: string;
  outputPath?: string;
  options: JobOptions;
};

type OutputFormat = 'mp4' | 'mov';

type BatchSettings = {
  outputDir: string | null;
  format: OutputFormat;
  outputNameTemplate: string;
  defaultQuality: QualityPreset;
  defaultFps: number | null;
  staticDuration: number;
};

const MAX_CONCURRENT = 2;
const DEFAULT_OPTIONS: JobOptions = {
  quality: 'high',
  fps: null,
};
const DEFAULT_BATCH_SETTINGS: BatchSettings = {
  outputDir: null,
  format: 'mp4',
  outputNameTemplate: '{name}',
  defaultQuality: 'high',
  defaultFps: null,
  staticDuration: 1,
};
const QUALITY_OPTIONS: { value: QualityPreset; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'small', label: 'Small' },
];
const FPS_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Original' },
  { value: 24, label: '24' },
  { value: 30, label: '30' },
  { value: 60, label: '60' },
];
const FORMAT_OPTIONS: { value: OutputFormat; label: string }[] = [
  { value: 'mp4', label: 'MP4 (H.264)' },
  { value: 'mov', label: 'MOV (H.264)' },
];

export function VideoConverter() {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [batchSettings, setBatchSettings] = useState<BatchSettings>(DEFAULT_BATCH_SETTINGS);
  const nextSequence = useRef(1);

  // Set up Tauri file drop listener
  useEffect(() => {
    let unlistenDrop: (() => void) | undefined;
    let unlistenHover: (() => void) | undefined;
    let unlistenCancel: (() => void) | undefined;

    const setupFileDropListener = async () => {
      const appWindow = getCurrentWindow();
      
      unlistenHover = await appWindow.listen('tauri://drag-enter', () => {
        setIsDragging(true);
      });

      unlistenDrop = await appWindow.listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
        setIsDragging(false);
        if (event.payload?.paths?.length > 0) {
          addFiles(event.payload.paths);
        }
      });

      unlistenCancel = await appWindow.listen('tauri://drag-leave', () => {
        setIsDragging(false);
      });
    };

    setupFileDropListener();

    return () => {
      if (unlistenDrop) unlistenDrop();
      if (unlistenHover) unlistenHover();
      if (unlistenCancel) unlistenCancel();
    };
  }, []);

  const handleSelectFile = async () => {
    try {
      const file = await openDialog({
        multiple: true,
        filters: [{
          name: 'WebP Video',
          extensions: ['webp']
        }],
        directory: false
      });

      if (!file) return;

      const files = Array.isArray(file) ? file : [file];
      addFiles(files);
    } catch (error) {
      console.error('Error selecting file:', error);
    }
  };

  const handleSelectOutputDir = async () => {
    try {
      const folder = await openDialog({
        multiple: false,
        directory: true,
      });
      if (!folder || Array.isArray(folder)) return;
      setBatchSettings(prev => ({ ...prev, outputDir: folder }));
    } catch (error) {
      console.error('Error selecting output directory:', error);
    }
  };

  const addFiles = (files: string[]) => {
    setJobs(prev => {
      const existing = new Set(prev.map(job => job.path));
      let sequence = nextSequence.current;
      const additions = files
        .filter(path => !existing.has(path))
        .map(path => ({
          id: crypto.randomUUID(),
          path,
          name: path.split('/').pop() || path,
          sequence: sequence++,
          status: 'idle' as JobStatus,
          progress: 0,
          options: {
            quality: batchSettings.defaultQuality ?? DEFAULT_OPTIONS.quality,
            fps: batchSettings.defaultFps ?? DEFAULT_OPTIONS.fps,
          },
        }));
      nextSequence.current = sequence;
      return [...prev, ...additions];
    });
  };

  const updateJob = (id: string, patch: Partial<JobItem>) => {
    setJobs(prev =>
      prev.map(job => (job.id === id ? { ...job, ...patch } : job))
    );
  };

  const updateJobOptions = (id: string, patch: Partial<JobOptions>) => {
    setJobs(prev =>
      prev.map(job =>
        job.id === id ? { ...job, options: { ...job.options, ...patch } } : job
      )
    );
  };

  const applyDefaultsToAll = () => {
    setJobs(prev =>
      prev.map(job => ({
        ...job,
        options: {
          ...job.options,
          quality: batchSettings.defaultQuality,
          fps: batchSettings.defaultFps,
        },
      }))
    );
  };

  const extractLogPath = (message?: string) => {
    if (!message) return null;
    const match = message.match(/Log:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  };

  const handleConvertJob = async (job: JobItem) => {
    if (job.status === 'converting') return;
    updateJob(job.id, { status: 'converting', progress: 0, error: undefined, outputPath: undefined });

    try {
      const outputPath = await convertWebPToMp4(
        job.path,
        job.id,
        {
          outputDir: batchSettings.outputDir,
          quality: job.options.quality,
          fps: job.options.fps,
          format: batchSettings.format,
          outputNameTemplate: batchSettings.outputNameTemplate,
          sequence: job.sequence,
          staticDuration: batchSettings.staticDuration,
        },
        (prog) => {
          updateJob(job.id, { progress: prog });
        }
      );

      updateJob(job.id, { status: 'success', progress: 100, outputPath });
    } catch (error) {
      console.error('Conversion error:', error);
      const message = error instanceof Error ? error.message : 'Conversion failed';
      updateJob(job.id, { status: 'error', error: message });
    }
  };

  const handleStartAll = async () => {
    if (batchRunning) return;
    const queue = jobs.filter(job => job.status === 'idle' || job.status === 'error');
    if (!queue.length) return;

    setBatchRunning(true);
    const ids = queue.map(job => job.id);
    const jobMap = new Map(jobs.map(job => [job.id, job]));
    const queueIds = [...ids];

    const runNext = async (): Promise<void> => {
      const id = queueIds.shift();
      if (!id) return;
      const current = jobMap.get(id);
      if (current) {
        await handleConvertJob(current);
      }
      await runNext();
    };

    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT, queueIds.length) },
      () => runNext()
    );

    await Promise.all(workers);
    setBatchRunning(false);
  };

  const handleClearCompleted = () => {
    setJobs(prev => prev.filter(job => job.status !== 'success'));
  };

  const handleRemoveJob = (jobId: string) => {
    setJobs(prev => prev.filter(job => job.id !== jobId));
  };

  const handleOpenPath = async (path?: string) => {
    if (!path) return;
    try {
      await openPath(path);
    } catch (error) {
      console.error('Failed to open path:', error);
      try {
        await revealItemInDir(path);
      } catch (revealError) {
        console.error('Failed to reveal path:', revealError);
      }
    }
  };

  const columns = useMemo<ColumnDef<JobItem>[]>(() => [
    {
      header: 'File',
      accessorKey: 'name',
      size: 300,
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="truncate text-[12px] font-semibold text-gray-900 dark:text-gray-100">{row.original.name}</p>
          <p className="truncate text-[11px] text-gray-400 dark:text-neutral-500">{row.original.path}</p>
        </div>
      ),
    },
    {
      header: 'Status',
      id: 'status',
      size: 110,
      cell: ({ row }) => {
        const job = row.original;
        return (
          <div className="space-y-1 text-[11px]">
            {job.status === 'success' && (
              <span className="flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                Done
              </span>
            )}
            {job.status === 'error' && (
              <span className="flex items-center gap-1 font-semibold text-rose-600 dark:text-rose-400">
                <AlertCircle className="h-3 w-3" />
                Failed
              </span>
            )}
            {job.status === 'converting' && (
              <span className="flex items-center gap-1 font-semibold text-gray-700 dark:text-gray-300">
                <Play className="h-3 w-3" />
                Converting
              </span>
            )}
            {job.status === 'idle' && (
              <span className="text-gray-400 dark:text-neutral-500">Idle</span>
            )}
            <span className="text-[11px] text-gray-400 dark:text-neutral-500">{job.progress.toFixed(0)}%</span>
          </div>
        );
      },
    },
    {
      header: 'Quality',
      id: 'quality',
      size: 120,
      cell: ({ row }) => (
        <div className="relative inline-flex w-full max-w-[140px] items-center">
          <select
            className="h-8 w-full appearance-none rounded-lg border border-black/10 bg-white px-3 pr-7 text-[12px] font-medium text-gray-800 shadow-sm outline-none transition hover:bg-gray-50 focus:ring-2 focus:ring-black/10 dark:border-white/10 dark:bg-neutral-900 dark:text-gray-100 dark:hover:bg-neutral-800 dark:focus:ring-white/10"
            value={row.original.options.quality}
            onChange={(event) =>
              updateJobOptions(row.original.id, { quality: event.target.value as QualityPreset })
            }
            disabled={row.original.status === 'converting'}
          >
            {QUALITY_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2 text-[10px] text-gray-500 dark:text-neutral-400">
            ▾
          </span>
        </div>
      ),
    },
    {
      header: 'FPS',
      id: 'fps',
      size: 120,
      cell: ({ row }) => (
        <div className="relative inline-flex w-full max-w-[140px] items-center">
          <select
            className="h-8 w-full appearance-none rounded-lg border border-black/10 bg-white px-3 pr-7 text-[12px] font-medium text-gray-800 shadow-sm outline-none transition hover:bg-gray-50 focus:ring-2 focus:ring-black/10 dark:border-white/10 dark:bg-neutral-900 dark:text-gray-100 dark:hover:bg-neutral-800 dark:focus:ring-white/10"
            value={row.original.options.fps ?? 'auto'}
            onChange={(event) => {
              const value = event.target.value;
              updateJobOptions(row.original.id, { fps: value === 'auto' ? null : Number(value) });
            }}
            disabled={row.original.status === 'converting'}
          >
            {FPS_OPTIONS.map(option => (
              <option key={option.label} value={option.value ?? 'auto'}>
                {option.label === 'Original' ? 'Original' : `${option.label} fps`}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2 text-[10px] text-gray-500 dark:text-neutral-400">
            ▾
          </span>
        </div>
      ),
    },
    {
      header: 'Actions',
      id: 'actions',
      size: 160,
      cell: ({ row }) => {
        const job = row.original;
        const logPath = extractLogPath(job.error);
        return (
          <div className="flex w-full items-center gap-1">
            <Button
              variant="default"
              size="sm"
              onClick={() => handleConvertJob(job)}
              disabled={job.status === 'converting'}
              className="h-7 rounded-full bg-gray-900 px-2 text-[11px] text-white hover:bg-black disabled:bg-gray-300 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
            >
              {job.status === 'converting' ? 'Running' : 'Convert'}
            </Button>
            {job.outputPath && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => revealItemInDir(job.outputPath!)}
                className="h-7 rounded-full px-2 text-[11px] text-gray-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
              >
                Reveal
              </Button>
            )}
            {logPath && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleOpenPath(logPath)}
                className="h-7 rounded-full px-2 text-[11px] text-gray-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
              >
                Log
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleRemoveJob(job.id)}
              className="ml-auto h-7 w-7 rounded-full p-0 text-gray-500 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        );
      },
    },
  ], [batchSettings.outputDir, jobs.length]);

  const table = useReactTable({
    data: jobs,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const stats = useMemo(() => {
    const total = jobs.length;
    const done = jobs.filter(job => job.status === 'success').length;
    const running = jobs.filter(job => job.status === 'converting').length;
    return { total, done, running };
  }, [jobs]);

  return (
    <div
      className="min-h-screen bg-[#f6f6f8] dark:bg-neutral-950 text-gray-900 dark:text-gray-100 overflow-x-hidden"
      style={{ fontFamily: '"SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif' }}
    >
      <div className="flex min-h-screen w-full flex-col pb-16">
        <header className="sticky top-0 z-30 border-b border-black/5 dark:border-white/10 bg-white/70 dark:bg-neutral-900/70 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
            <div className="flex items-center gap-3">
              <p className="text-[11px] text-gray-500 dark:text-neutral-400">{stats.total} queued</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={handleSelectFile}
                className="h-8 rounded-full border-black/10 bg-white/80 px-3 text-xs text-gray-700 shadow-sm hover:bg-white dark:border-white/10 dark:bg-neutral-900 dark:text-gray-100 dark:hover:bg-neutral-800"
              >
                <Upload className="mr-1 h-3.5 w-3.5" />
                Add Files
              </Button>
              <Button
                onClick={handleStartAll}
                disabled={batchRunning || jobs.length === 0}
                className="h-8 rounded-full bg-gray-900 px-3 text-xs text-white shadow-sm hover:bg-black disabled:bg-gray-300 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                <Play className="mr-1 h-3.5 w-3.5" />
                {batchRunning ? 'Running...' : 'Start All'}
              </Button>
              <Button
                variant="ghost"
                className="h-8 rounded-full px-3 text-xs text-gray-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
                onClick={() => setShowSettings(prev => !prev)}
              >
                {showSettings ? 'Hide Settings' : 'Batch Settings'}
              </Button>
              <Button
                variant="ghost"
                className="h-8 rounded-full px-3 text-xs text-gray-500 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
                onClick={handleClearCompleted}
                disabled={jobs.length === 0}
              >
                Clear Completed
              </Button>
            </div>
          </div>
        </header>
        {showSettings && (
          <div className="px-4 pt-3">
            <div className="rounded-2xl border border-black/5 bg-white/80 p-4 text-[12px] text-gray-700 shadow-sm dark:border-white/10 dark:bg-neutral-900/70 dark:text-neutral-200">
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">Output folder</p>
                  <div className="flex items-center gap-2 rounded-lg border border-black/10 bg-white px-3 py-2 dark:border-white/10 dark:bg-neutral-900">
                    <Folder className="h-3.5 w-3.5 text-gray-500 dark:text-neutral-400" />
                    <span className="flex-1 truncate text-[12px] text-gray-700 dark:text-neutral-200">
                      {batchSettings.outputDir ? batchSettings.outputDir : 'Same folder as source'}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 rounded-full px-2 text-[11px] text-gray-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
                      onClick={handleSelectOutputDir}
                    >
                      Choose…
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">Output format</p>
                  <div className="relative">
                    <select
                      className="h-8 w-full appearance-none rounded-lg border border-black/10 bg-white px-3 pr-7 text-[12px] font-medium text-gray-800 shadow-sm outline-none transition hover:bg-gray-50 focus:ring-2 focus:ring-black/10 dark:border-white/10 dark:bg-neutral-900 dark:text-gray-100 dark:hover:bg-neutral-800 dark:focus:ring-white/10"
                      value={batchSettings.format}
                      onChange={(event) =>
                        setBatchSettings(prev => ({ ...prev, format: event.target.value as OutputFormat }))
                      }
                    >
                      {FORMAT_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-gray-500 dark:text-neutral-400">
                      ▾
                    </span>
                  </div>
                </div>
                <div className="space-y-2 md:col-span-2 lg:col-span-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">Output name</p>
                  <input
                    className="h-8 w-full rounded-lg border border-black/10 bg-white px-3 text-[12px] text-gray-800 shadow-sm outline-none transition placeholder:text-gray-400 focus:ring-2 focus:ring-black/10 dark:border-white/10 dark:bg-neutral-900 dark:text-gray-100 dark:placeholder:text-neutral-500 dark:focus:ring-white/10"
                    value={batchSettings.outputNameTemplate}
                    onChange={(event) =>
                      setBatchSettings(prev => ({ ...prev, outputNameTemplate: event.target.value }))
                    }
                    placeholder="{name}_converted_{counter}"
                  />
                  <p className="text-[11px] text-gray-500 dark:text-neutral-400">
                    Tokens: {`{name}`} {`{counter}`} {`{date}`} {`{time}`} {`{ext}`}
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">Default quality</p>
                  <div className="relative">
                    <select
                      className="h-8 w-full appearance-none rounded-lg border border-black/10 bg-white px-3 pr-7 text-[12px] font-medium text-gray-800 shadow-sm outline-none transition hover:bg-gray-50 focus:ring-2 focus:ring-black/10 dark:border-white/10 dark:bg-neutral-900 dark:text-gray-100 dark:hover:bg-neutral-800 dark:focus:ring-white/10"
                      value={batchSettings.defaultQuality}
                      onChange={(event) =>
                        setBatchSettings(prev => ({
                          ...prev,
                          defaultQuality: event.target.value as QualityPreset,
                        }))
                      }
                    >
                      {QUALITY_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-gray-500 dark:text-neutral-400">
                      ▾
                    </span>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">Default FPS</p>
                  <div className="relative">
                    <select
                      className="h-8 w-full appearance-none rounded-lg border border-black/10 bg-white px-3 pr-7 text-[12px] font-medium text-gray-800 shadow-sm outline-none transition hover:bg-gray-50 focus:ring-2 focus:ring-black/10 dark:border-white/10 dark:bg-neutral-900 dark:text-gray-100 dark:hover:bg-neutral-800 dark:focus:ring-white/10"
                      value={batchSettings.defaultFps ?? 'auto'}
                      onChange={(event) => {
                        const value = event.target.value;
                        setBatchSettings(prev => ({
                          ...prev,
                          defaultFps: value === 'auto' ? null : Number(value),
                        }));
                      }}
                    >
                      {FPS_OPTIONS.map(option => (
                        <option key={option.label} value={option.value ?? 'auto'}>
                          {option.label === 'Original' ? 'Original' : `${option.label} fps`}
                        </option>
                      ))}
                    </select>
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-gray-500 dark:text-neutral-400">
                      ▾
                    </span>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">Static duration</p>
                  <input
                    type="number"
                    min={0.5}
                    step={0.5}
                    className="h-8 w-full rounded-lg border border-black/10 bg-white px-3 text-[12px] text-gray-800 shadow-sm outline-none transition focus:ring-2 focus:ring-black/10 dark:border-white/10 dark:bg-neutral-900 dark:text-gray-100 dark:focus:ring-white/10"
                    value={batchSettings.staticDuration}
                    onChange={(event) =>
                      setBatchSettings(prev => ({
                        ...prev,
                        staticDuration: Math.max(0.5, Number(event.target.value || 1)),
                      }))
                    }
                  />
                  <p className="text-[11px] text-gray-500 dark:text-neutral-400">Seconds for non-animated WebP.</p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-gray-500 dark:text-neutral-400">
                  Defaults apply to new files you add to the queue.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-full border-black/10 bg-white px-3 text-[11px] text-gray-700 shadow-sm hover:bg-gray-50 dark:border-white/10 dark:bg-neutral-900 dark:text-gray-100 dark:hover:bg-neutral-800"
                  onClick={applyDefaultsToAll}
                  disabled={jobs.length === 0}
                >
                  Apply defaults to all
                </Button>
              </div>
            </div>
          </div>
        )}
        <section className="flex-1 overflow-y-auto px-4 pb-6 pt-4">
          {jobs.length === 0 ? (
            <div className="flex min-h-[60vh] items-center justify-center">
              <div className="flex w-full max-w-md flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-gray-200 bg-white/70 px-6 py-14 text-center shadow-sm dark:border-white/10 dark:bg-neutral-900/60">
                <FileVideo className="h-10 w-10 text-gray-300 dark:text-neutral-600" />
                <div>
                  <p className="text-lg font-semibold">No files queued</p>
                  <p className="text-sm text-gray-500 dark:text-neutral-400">Drop WebP files here or add them above.</p>
                </div>
                <Button
                  onClick={handleSelectFile}
                  className="h-9 rounded-full bg-gray-900 px-4 text-xs text-white shadow-sm hover:bg-black dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                >
                  <Upload className="mr-2 h-4 w-4" />
                  Add WebP Files
                </Button>
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-black/5 bg-white/80 shadow-sm dark:border-white/10 dark:bg-neutral-900/70">
              <table className="w-full table-fixed text-left text-[12px]">
                <colgroup>
                  {table.getAllLeafColumns().map(column => (
                    <col key={column.id} style={{ width: column.getSize() }} />
                  ))}
                </colgroup>
                <thead className="sticky top-0 z-10 bg-white/90 text-[11px] font-medium text-gray-500 backdrop-blur dark:bg-neutral-900/80 dark:text-neutral-400">
                  {table.getHeaderGroups().map(headerGroup => (
                    <tr key={headerGroup.id} className="border-b border-black/5 dark:border-white/10">
                      {headerGroup.headers.map(header => (
                        <th key={header.id} className="px-3 py-2 font-medium">
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((row) => (
                    <tr key={row.id} className="border-b border-black/5 last:border-b-0 hover:bg-gray-50/80 dark:border-white/5 dark:hover:bg-white/5">
                      {row.getVisibleCells().map(cell => (
                        <td key={cell.id} className="px-3 py-3 align-top">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-white/70 text-sm text-gray-600 backdrop-blur dark:bg-neutral-900/70 dark:text-neutral-300">
          <div className="rounded-2xl border border-dashed border-gray-300 bg-white/90 px-8 py-6 text-sm shadow-sm dark:border-white/20 dark:bg-neutral-900/90">
            Drop files to add them to the queue
          </div>
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 border-t border-black/5 bg-white/70 backdrop-blur dark:border-white/10 dark:bg-neutral-900/70">
        <div className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-2 text-[11px] text-gray-500 dark:text-neutral-400">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-semibold text-gray-900 dark:text-gray-100">{stats.total} files</span>
            <span>{stats.running} running</span>
            <span>{stats.done} done</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-full border border-black/10 bg-white/80 px-2 py-1 text-[11px] text-gray-600 shadow-sm dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-300">
              <Folder className="h-3 w-3" />
              <span className="max-w-[180px] truncate">
                {batchSettings.outputDir ? batchSettings.outputDir : 'Same folder'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 rounded-full px-2 text-[11px] text-gray-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
                onClick={handleSelectOutputDir}
              >
                Choose…
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
