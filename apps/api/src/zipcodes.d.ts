// The zipcodes package ships without types; only the two lookups the API uses are declared.
declare module "zipcodes" {
  type ZipRecord = { zip: string; latitude: number; longitude: number; city: string; state: string; country: string };
  const zipcodes: { lookup(zip: string | number): ZipRecord | undefined; lookupByName(city: string, state: string): ZipRecord[] };
  export default zipcodes;
}
