// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Assertions read the inline Title-Case defaults, matching the existing
    // SPA component tests, so a missing bundle key fails visibly here rather
    // than rendering a raw key.
    t: (key: string, fallback?: string, vars?: Record<string, string | number>) => {
      let text = fallback ?? key;
      for (const [k, v] of Object.entries(vars ?? {})) text = text.replace(`{{${k}}}`, String(v));
      return text;
    },
  }),
}));

import { VolumeFilePager } from '../apps/web/src/views/volume/VolumeFilePager';

const NOOP = () => undefined;

/**
 * The pager only renders for a collection that has rows — a folder that failed
 * to load leaves `total` meaningless, and the pager used to render anyway.
 */
const ROWS = [{ name: 'a.txt' }];

describe('VolumeFilePager', () => {
  it('renders nothing when the server does not page', () => {
    // An older backend behind a router returns a full listing with no paging
    // headers. Showing a pager there would imply more pages than exist.
    const { container } = render(<VolumeFilePager entries={ROWS} page={1} limit={100} total={null} paged={false} onPageChange={NOOP} onPageSizeChange={NOOP} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the whole collection fits on one page', () => {
    const { container } = render(<VolumeFilePager entries={ROWS} page={1} limit={100} total={12} paged onPageChange={NOOP} onPageSizeChange={NOOP} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the row range and the page counter for a multi-page collection', () => {
    render(<VolumeFilePager entries={ROWS} page={2} limit={100} total={12_431} paged onPageChange={NOOP} onPageSizeChange={NOOP} />);
    expect(screen.getByTestId('volume-pager-range').textContent).toBe('101–200 of 12431');
    expect(screen.getByText('Page 2 of 125').textContent).toBe('Page 2 of 125');
  });

  it('disables Previous on the first page and Next on the last', () => {
    // The accessible names are the long forms ("Previous Page" / "Next Page");
    // the visible labels are the short ones.
    const { unmount } = render(<VolumeFilePager entries={ROWS} page={1} limit={100} total={250} paged onPageChange={NOOP} onPageSizeChange={NOOP} />);
    expect(screen.getByLabelText('Previous Page').hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('Next Page').hasAttribute('disabled')).toBe(false);
    unmount();

    render(<VolumeFilePager entries={ROWS} page={3} limit={100} total={250} paged onPageChange={NOOP} onPageSizeChange={NOOP} />);
    expect(screen.getByLabelText('Previous Page').hasAttribute('disabled')).toBe(false);
    expect(screen.getByLabelText('Next Page').hasAttribute('disabled')).toBe(true);
  });

  it('advances and rewinds by one page', () => {
    const onPageChange = vi.fn();
    render(<VolumeFilePager entries={ROWS} page={2} limit={100} total={12_431} paged onPageChange={onPageChange} onPageSizeChange={NOOP} />);
    fireEvent.click(screen.getByLabelText('Next Page'));
    expect(onPageChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByLabelText('Previous Page'));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('clamps the last row of a partial final page to the total', () => {
    // 250 entries over 100-per-page: the third page holds 50 rows, so the
    // range must read 201-250 rather than 201-300.
    render(<VolumeFilePager entries={ROWS} page={3} limit={100} total={250} paged onPageChange={NOOP} onPageSizeChange={NOOP} />);
    expect(screen.getByTestId('volume-pager-range').textContent).toBe('201–250 of 250');
  });

  it('reports a page-size change with the selected value', () => {
    const onPageSizeChange = vi.fn();
    render(<VolumeFilePager entries={ROWS} page={1} limit={100} total={12_431} paged onPageChange={NOOP} onPageSizeChange={onPageSizeChange} />);
    fireEvent.change(screen.getByLabelText('Per Page'), { target: { value: '250' } });
    expect(onPageSizeChange).toHaveBeenCalledWith(250);
  });

  it('offers exactly the three supported page sizes', () => {
    render(<VolumeFilePager entries={ROWS} page={1} limit={100} total={12_431} paged onPageChange={NOOP} onPageSizeChange={NOOP} />);
    const options = Array.from(screen.getByLabelText('Per Page').querySelectorAll('option'), (o) => o.value);
    expect(options).toEqual(['50', '100', '250']);
  });

  it('renders nothing for a folder that loaded no rows', () => {
    // `total` still describes the previous folder, so a pager here would read
    // "Page 1 of 3 - 1-100 of 300" under "This Folder Does Not Exist", and Next
    // would page a folder that is not there.
    const { container } = render(<VolumeFilePager entries={[]} page={1} limit={100} total={300} paged onPageChange={NOOP} onPageSizeChange={NOOP} />);
    expect(container.firstChild).toBeNull();
  });
});
