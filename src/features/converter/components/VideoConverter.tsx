import { useMemo, useState, useEffect } from 'react';
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
  status: JobStatus;
  progress: number;
  error?: string;
  outputPath?: string;
  options: JobOptions;
};

type BatchSettings = {
  outputDir: string | null;
};

const MAX_CONCURRENT = 2;
const DEFAULT_OPTIONS: JobOptions = {
  quality: 'high',
  fps: null,
};

export function VideoConverter() {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [batchSettings, setBatchSettings] = useState<BatchSettings>({
    outputDir: null,
  });

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
      const additions = files
        .filter(path => !existing.has(path))
        .map(path => ({
          id: crypto.randomUUID(),
          path,
          name: path.split('/').pop() || path,
          status: 'idle' as JobStatus,
          progress: 0,
          options: { ...DEFAULT_OPTIONS },
        }));
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
          <p className="truncate text-xs font-semibold text-gray-900 dark:text-gray-100">{row.original.name}</p>
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
              <span className="flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-500">
                <CheckCircle2 className="h-3 w-3" />
                Done
              </span>
            )}
            {job.status === 'error' && (
              <span className="flex items-center gap-1 font-semibold text-rose-700 dark:text-rose-500">
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
      size: 90,
      cell: ({ row }) => (
        <select
          className="h-7 w-full rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100 px-2 text-[11px]"
          value={row.original.options.quality}
          onChange={(event) =>
            updateJobOptions(row.original.id, { quality: event.target.value as QualityPreset })
          }
          disabled={row.original.status === 'converting'}
        >
          <option value="high">High</option>
          <option value="balanced">Balanced</option>
          <option value="small">Small</option>
        </select>
      ),
    },
    {
      header: 'FPS',
      id: 'fps',
      size: 80,
      cell: ({ row }) => (
        <select
          className="h-7 w-full rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100 px-2 text-[11px]"
          value={row.original.options.fps ?? 'auto'}
          onChange={(event) => {
            const value = event.target.value;
            updateJobOptions(row.original.id, { fps: value === 'auto' ? null : Number(value) });
          }}
          disabled={row.original.status === 'converting'}
        >
          <option value="auto">Original</option>
          <option value="24">24 fps</option>
          <option value="30">30 fps</option>
          <option value="60">60 fps</option>
        </select>
      ),
    },
    {
      header: 'Actions',
      id: 'actions',
      size: 140,
      cell: ({ row }) => {
        const job = row.original;
        const logPath = extractLogPath(job.error);
        return (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="default"
              size="sm"
              onClick={() => handleConvertJob(job)}
              disabled={job.status === 'converting'}
              className="h-7 px-2 text-[11px]"
            >
              {job.status === 'converting' ? 'Running' : 'Convert'}
            </Button>
            {job.outputPath && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => revealItemInDir(job.outputPath!)}
                className="h-7 px-2 text-[11px]"
              >
                Reveal
              </Button>
            )}
            {logPath && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleOpenPath(logPath)}
                className="h-7 px-2 text-[11px]"
              >
                Log
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleRemoveJob(job.id)}
              className="h-7 w-7 p-0"
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
      className="min-h-screen bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 overflow-x-hidden"
      style={{ fontFamily: '"SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif' }}
    >
      <div className="flex min-h-screen w-full flex-col pb-20">
        <section className="flex-1 overflow-y-auto">
          {jobs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 border-b border-gray-200 dark:border-neutral-700 py-16 text-center">
              <FileVideo className="h-10 w-10 text-gray-300 dark:text-neutral-600" />
              <div>
                <p className="text-lg font-semibold">No files queued</p>
                <p className="text-sm text-gray-400 dark:text-neutral-500">Drop WebP files here or add them below.</p>
              </div>
              <Button onClick={handleSelectFile} className="gap-2">
                <Upload className="h-4 w-4" />
                Add WebP Files
              </Button>
            </div>
          ) : (
            <div className="border-y border-gray-200 dark:border-neutral-700 overflow-x-hidden">
              <table className="w-full table-fixed text-left text-xs">
                <colgroup>
                  {table.getAllLeafColumns().map(column => (
                    <col key={column.id} style={{ width: column.getSize() }} />
                  ))}
                </colgroup>
                <thead className="sticky top-0 z-10 bg-gray-50 dark:bg-neutral-800 text-[10px] uppercase tracking-wide text-gray-500 dark:text-neutral-400">
                  {table.getHeaderGroups().map(headerGroup => (
                    <tr key={headerGroup.id} className="border-b border-gray-200 dark:border-neutral-700">
                      {headerGroup.headers.map(header => (
                        <th key={header.id} className="px-2 py-2 font-semibold">
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((row, index) => (
                    <tr key={row.id} className={index % 2 === 0 ? 'bg-white dark:bg-neutral-900' : 'bg-gray-50/60 dark:bg-neutral-800/60'}>
                      {row.getVisibleCells().map(cell => (
                        <td key={cell.id} className="px-2 py-2 align-top">
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
        <div className="pointer-events-none fixed inset-0 flex items-center justify-center bg-white/80 dark:bg-neutral-900/80 text-sm text-gray-500 dark:text-neutral-400">
          Drop files to add them to the queue
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 border-t border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-900">
          <div className="flex w-full flex-wrap items-center justify-between gap-2 px-2 py-2">
            <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600 dark:text-neutral-400">
              <span className="font-semibold text-gray-900 dark:text-gray-100">{stats.total} files</span>
              <span>{stats.running} running</span>
              <span>{stats.done} done</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 rounded-full border border-gray-200 dark:border-neutral-700 px-2 py-1 text-[11px] text-gray-500 dark:text-neutral-400">
                <Folder className="h-3 w-3" />
                <span className="max-w-[160px] truncate">
                  {batchSettings.outputDir ? batchSettings.outputDir : 'Same folder'}
                </span>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] dark:text-gray-300 dark:hover:bg-neutral-800 dark:hover:text-gray-100" onClick={handleSelectOutputDir}>
                  Choose
                </Button>
              </div>
            <Button variant="outline" onClick={handleSelectFile} className="h-8 gap-2 px-3 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-gray-100 dark:hover:bg-neutral-700">
              <Upload className="h-3 w-3" />
              Add Files
            </Button>
            <Button
              onClick={handleStartAll}
              disabled={batchRunning || jobs.length === 0}
              className="h-8 gap-2 px-3 text-xs dark:bg-blue-600 dark:hover:bg-blue-700 dark:text-white"
            >
              <Play className="h-3 w-3" />
              {batchRunning ? 'Running batch...' : 'Start All'}
            </Button>
            <Button variant="ghost" className="h-8 px-2 text-xs dark:text-gray-300 dark:hover:bg-neutral-800 dark:hover:text-gray-100" onClick={handleClearCompleted} disabled={jobs.length === 0}>
              Clear Completed
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
