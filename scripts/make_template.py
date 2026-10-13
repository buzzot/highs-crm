"""Builds public/templates/lumi-trade-product-import-template.xlsx — the file sent to suppliers.
Run:  python3 scripts/make_template.py
Sheet / column headers are what the importer looks for, so keep them in sync with src/lib/product-import.js.
"""
import io, os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.comments import Comment
from openpyxl.drawing.image import Image as XLImage
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'templates', 'lumi-trade-product-import-template.xlsx')
F = 'Arial'
NAVY = '0F3D5C'; INPUT = 'FFF7D6'; EX = 'EEF2F7'; GREY = '7A8494'
thin = Side(style='thin', color='D5DAE1')
box = Border(left=thin, right=thin, top=thin, bottom=thin)

def font(**kw): return Font(name=F, **kw)

wb = Workbook()

# ---------------- Instructions ----------------
ws = wb.active; ws.title = 'Instructions'
ws.sheet_view.showGridLines = False
ws.column_dimensions['A'].width = 3; ws.column_dimensions['B'].width = 110
lines = [
    ('Lumi Trade — Supplier product form  /  供应商产品信息表', font(size=16, bold=True, color=NAVY)),
    ('Template version HB-PI-1', font(size=9, color=GREY)),
    ('', None),
    ('How to fill in  /  填写说明', font(size=12, bold=True, color=NAVY)),
    ('1.  Sheet "Supplier": fill in your company details in the yellow cells.  在"Supplier"表的黄色单元格填写贵公司信息。', font(size=10)),
    ('2.  Sheet "Products": one product per row, starting from row 4. Row 3 is an example — you can overwrite or delete it.', font(size=10)),
    ('     在"Products"表中每行填写一个产品，从第4行开始。第3行为示例，可覆盖或删除。', font(size=10)),
    ('3.  Photo: click the cell in the Photo column, then Insert → Pictures. Keep the picture inside its row (resize it to fit).', font(size=10)),
    ('     WPS: 插入 → 图片 → 嵌入单元格 is also fine.  照片：选中Photo列单元格，插入→图片，并调整大小放在该行内。', font(size=10)),
    ('4.  Units: weights in kilograms (kg), sizes in centimetres (cm). Unit = one piece in its retail/inner packaging.', font(size=10)),
    ('     单位：重量为千克(kg)，尺寸为厘米(cm)。单品尺寸/重量指单个产品含内包装。', font(size=10)),
    ('5.  Carton = the standard export (master) carton: gross weight, outer size and how many pieces it holds.', font(size=10)),
    ('     外箱：标准出口外箱的毛重、外箱尺寸及每箱数量。', font(size=10)),
    ('6.  Price = your unit price for the stated MOQ, in the currency you choose (CNY / USD / EUR), excluding shipping.', font(size=10)),
    ('     价格：起订量下的单价（不含运费），请选择币种。', font(size=10)),
    ('7.  HS code: the export customs code you use for this product (6–10 digits), if known.  海关编码（如已知）。', font(size=10)),
    ('8.  Save as .xlsx and email it back. Please do not rename sheets or columns.  请保存为.xlsx格式发回，勿修改表名或列名。', font(size=10)),
    ('', None),
    ('Questions? Reply to the email you received this form with.  如有疑问，请回复发送此表格的邮件。', font(size=10, italic=True, color=GREY)),
]
for i, (t, f) in enumerate(lines, start=2):
    c = ws.cell(row=i, column=2, value=t)
    if f: c.font = f
    c.alignment = Alignment(wrap_text=True, vertical='top')
ws.cell(row=len(lines) + 3, column=2, value='Legend:  yellow cells = please fill in   ·   blue-grey row = example').font = font(size=9, color=GREY)

# ---------------- Supplier ----------------
ss = wb.create_sheet('Supplier')
ss.sheet_view.showGridLines = False
ss.column_dimensions['A'].width = 34; ss.column_dimensions['B'].width = 60
ss['A1'] = 'Supplier details  /  供应商信息'; ss['A1'].font = font(size=14, bold=True, color=NAVY)
ss['A2'] = 'Fill in the yellow cells.  请填写黄色单元格。'; ss['A2'].font = font(size=9, color=GREY)
fields = [
    ('Company name  /  公司名称', 'Full legal name, as on your business licence  营业执照上的全称'),
    ('Company address  /  公司地址', 'Street, district, city, province'),
    ('Contact person  /  联系人', ''),
    ('Email  /  邮箱', ''),
    ('Phone  /  电话', 'With country code, e.g. +86 138 0000 0000'),
    ('WeChat  /  微信', ''),
    ('Website / Alibaba store  /  网站', 'Optional  选填'),
]
for i, (label, hint) in enumerate(fields, start=4):
    a = ss.cell(row=i, column=1, value=label); a.font = font(size=10, bold=True); a.alignment = Alignment(vertical='center')
    b = ss.cell(row=i, column=2); b.fill = PatternFill('solid', fgColor=INPUT); b.border = box; b.font = font(size=10)
    b.alignment = Alignment(vertical='center', wrap_text=True)
    if hint: b.comment = Comment(hint, 'Lumi Trade')
    ss.row_dimensions[i].height = 22
ss.row_dimensions[5].height = 36

# ---------------- Products ----------------
ps = wb.create_sheet('Products')
ps.freeze_panes = 'C3'
cols = [
    ('Photo', '照片', 16, None),
    ('Product name', '产品名称', 30, None),
    ('Supplier SKU', '供应商货号', 16, None),
    ('Category', '产品类别', 18, None),
    ('HS code', '海关编码', 13, None),
    ('Unit weight (kg)', '单品重量 kg', 12, '0.000'),
    ('Unit length (cm)', '单品长 cm', 11, '0.0'),
    ('Unit width (cm)', '单品宽 cm', 11, '0.0'),
    ('Unit height (cm)', '单品高 cm', 11, '0.0'),
    ('Pcs per carton', '每箱数量', 11, '0'),
    ('Carton gross weight (kg)', '外箱毛重 kg', 13, '0.00'),
    ('Carton length (cm)', '外箱长 cm', 11, '0.0'),
    ('Carton width (cm)', '外箱宽 cm', 11, '0.0'),
    ('Carton height (cm)', '外箱高 cm', 11, '0.0'),
    ('Unit price', '单价', 11, '#,##0.00'),
    ('Currency', '币种', 10, None),
    ('MOQ (pcs)', '起订量', 10, '#,##0'),
    ('Notes', '备注 (材质/认证/包装等)', 34, None),
]
head_fill = PatternFill('solid', fgColor=NAVY)
sub_fill = PatternFill('solid', fgColor='DCE6F0')
for j, (en, cn, w, fmt) in enumerate(cols, start=1):
    letter = ps.cell(row=1, column=j).column_letter
    ps.column_dimensions[letter].width = w
    h = ps.cell(row=1, column=j, value=en); h.font = font(size=10, bold=True, color='FFFFFF'); h.fill = head_fill
    h.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True); h.border = box
    s = ps.cell(row=2, column=j, value=cn); s.font = font(size=9, color=NAVY); s.fill = sub_fill
    s.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True); s.border = box
ps.row_dimensions[1].height = 32; ps.row_dimensions[2].height = 18

example = [None, 'LED desk lamp 10W, foldable', 'EXAMPLE-001', 'Lighting', '9405.21', 0.65, 32, 12, 8,
           20, 14.2, 52, 38, 23, 38.5, 'CNY', 500, 'Aluminium + ABS, USB-C, CE/RoHS, colour box']
ex_fill = PatternFill('solid', fgColor=EX)
for j, v in enumerate(example, start=1):
    c = ps.cell(row=3, column=j, value=v); c.fill = ex_fill; c.border = box
    c.font = font(size=10, italic=True, color='4A5566'); c.alignment = Alignment(vertical='center', wrap_text=True)
    if cols[j - 1][3]: c.number_format = cols[j - 1][3]
ps.cell(row=3, column=3).comment = Comment('Example row — overwrite or delete it. Rows with SKU "EXAMPLE-…" are ignored on import.\n示例行，可覆盖或删除。', 'Lumi Trade')
ps.row_dimensions[3].height = 62

# example photo (drawn, so the template has no third-party image)
img = Image.new('RGB', (160, 160), (247, 249, 252)); d = ImageDraw.Draw(img)
d.rectangle([40, 128, 120, 140], fill=(60, 72, 88)); d.line([80, 128, 64, 70], fill=(60, 72, 88), width=7)
d.line([64, 70, 108, 46], fill=(60, 72, 88), width=7); d.polygon([(98, 34), (132, 52), (114, 72)], fill=(11, 138, 122))
d.ellipse([112, 66, 124, 78], fill=(255, 214, 92))
buf = io.BytesIO(); img.save(buf, 'PNG'); buf.seek(0)
xi = XLImage(buf); xi.width = 78; xi.height = 78
ps.add_image(xi, 'A3')

# input area rows 4..503
for r in range(4, 504):
    ps.row_dimensions[r].height = 62
    for j, (_, _, _, fmt) in enumerate(cols, start=1):
        c = ps.cell(row=r, column=j); c.border = box; c.font = font(size=10)
        c.alignment = Alignment(vertical='center', wrap_text=(j in (2, 18)))
        if fmt: c.number_format = fmt
        if j > 1: c.fill = PatternFill('solid', fgColor=INPUT)

cur = DataValidation(type='list', formula1='"CNY,USD,EUR"', allow_blank=True, showErrorMessage=True,
                     errorTitle='Currency', error='Choose CNY, USD or EUR')
ps.add_data_validation(cur); cur.add('P3:P503')
num = DataValidation(type='decimal', operator='greaterThanOrEqual', formula1='0', allow_blank=True, showErrorMessage=True,
                     errorTitle='Number', error='Please enter a number (no units). 请输入数字，不要带单位。')
ps.add_data_validation(num); num.add('F3:O503'); num.add('Q3:Q503')
ps.cell(row=1, column=1).comment = Comment('Insert the product photo inside this cell (Insert → Pictures).\n插入→图片，放在本单元格内。', 'Lumi Trade')

# print: fit each sheet to one page wide
for sh, land in ((ws, False), (ss, False), (ps, True)):
    sh.page_setup.orientation = 'landscape' if land else 'portrait'
    sh.page_setup.fitToWidth = 1; sh.page_setup.fitToHeight = 0
    sh.sheet_properties.pageSetUpPr.fitToPage = True
ps.print_title_rows = '1:2'

wb.active = 1  # open on Supplier
wb.save(OUT)
print('wrote', os.path.abspath(OUT))
