import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseLoseItZip } from './loseitZip';

function makeZipFile(entries: Record<string, string>): File {
  const encoded: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) {
    encoded[name] = strToU8(content);
  }
  const zipped = zipSync(encoded);
  return new File([zipped], 'loseit-export.zip', { type: 'application/zip' });
}

describe('parseLoseItZip', () => {
  it('extracts and parses every supported category present in the zip', async () => {
    const file = makeZipFile({
      'food-logs.csv': 'Date,Name,Meal,Quantity,Units,Calories\n05/02/2023,Toast,Breakfast,1,Servings,200\n',
      'weights.csv': 'Date,Weight,Last Updated,Deleted\n05/02/2023,91.99,2023-05-02T00:00:00+0100,false\n',
      'fasting-logs.csv': 'Scheduled start,Scheduled duration,Actual start,Actual end,Deleted\n',
    });

    const { categories, previews } = await parseLoseItZip(file);

    expect(categories.diary).toHaveLength(1);
    expect(categories.weight).toHaveLength(1);
    expect(previews.map((p) => p.key).sort()).toEqual(['diary', 'weight']);
    // unsupported files are read but never surfaced
    expect((categories as Record<string, unknown>).fasting_logs).toBeUndefined();
  });

  it('returns no categories/previews for a zip with none of the known files', async () => {
    const file = makeZipFile({ 'notes.csv': 'Date,Title,Body\n' });
    const { categories, previews } = await parseLoseItZip(file);
    expect(Object.keys(categories)).toHaveLength(0);
    expect(previews).toHaveLength(0);
  });

  it('converts weight and relabels its preview when profile.csv indicates an imperial account', async () => {
    const file = makeZipFile({
      'weights.csv': 'Date,Weight,Last Updated\n05/02/2023,180,2023-05-02T00:00:00+0100\n',
      'profile.csv': 'Name,Value\nHeight,70.0\n',
    });

    const { categories, previews } = await parseLoseItZip(file);

    expect(categories.weight).toEqual([{ date: '2023-05-02', kg: 180 * 0.453592 }]);
    expect(previews.find((p) => p.key === 'weight')?.label).toBe('Weight (converted from lbs)');
  });

  it('leaves weight unconverted and its preview label as-is when profile.csv indicates metric', async () => {
    const file = makeZipFile({
      'weights.csv': 'Date,Weight,Last Updated\n05/02/2023,91.99,2023-05-02T00:00:00+0100\n',
      'profile.csv': 'Name,Value\nHeight,178.0\n',
    });

    const { categories, previews } = await parseLoseItZip(file);

    expect(categories.weight).toEqual([{ date: '2023-05-02', kg: 91.99 }]);
    expect(previews.find((p) => p.key === 'weight')?.label).toBe('Weight (imported as kg)');
  });
});
